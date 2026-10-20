import { test, expect, chromium } from "@playwright/test";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { initialConfig } from "../src/store.mjs";
import { buildChatter } from "../chatter/build.mjs";
await buildChatter();

// Chrome exposes the real side panel as a target that Playwright does not
// attach to as a Page. Use the public CDP target API for that surface.
async function attachPanel(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId });
  let id = 0;
  const pending = new Map();
  cdp.on("Target.receivedMessageFromTarget", (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      cdp
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id: key, method, params }),
        })
        .catch(reject);
    });
  return {
    send,
    evaluate: async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
  };
}

test("Chatter extension joins without Collector, shares chat with Player and restores stopped audio after reopening", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const initial = initialConfig({
    voice: {
      name: "テストの声",
      voice: "none",
      caption: "明るい声",
      seed: "1",
      steps: 10,
      speed: 1,
    },
  });
  initial.characters = [];
  initial.provider.type = "mock";
  const app = createApp({
    initial,
    dataDir: mkdtempSync(join(tmpdir(), "chatter-e2e-")),
    localOrigin: "http://127.0.0.1:0",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  let context, webContext, secondApp;
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const r = await fetch(base + "/api/v1/admin/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${app.store.secrets.admin}`,
      },
      body: JSON.stringify({
        command: "invite",
        commandId: crypto.randomUUID(),
      }),
    });
    const invite = (await r.json()).url;
    // Headless Chrome cannot click native optional-permission prompts. Grant
    // only the chosen test host in a temporary copy; production grants none.
    const extension = mkdtempSync(join(tmpdir(), "chatter-extension-"));
    cpSync(new URL("../chatter", import.meta.url), extension, {
      recursive: true,
    });
    const manifest = JSON.parse(readFileSync(join(extension, "manifest.json")));
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    manifest.host_permissions = ["http://127.0.0.1/*"];
    writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
    const profile = mkdtempSync(join(tmpdir(), "chatter-chrome-"));
    const launchOptions = {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    };
    context = await chromium.launchPersistentContext(profile, launchOptions);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    let panel = await context.newPage();
    await panel.goto(`chrome-extension://${id}/panel.html`);
    await panel.setViewportSize({ width: 360, height: 800 });
    await expect(panel.locator("#connection")).toBeVisible();
    await expect(panel.locator("#participant")).not.toBeVisible();
    await panel.locator("#bridgeAddress").fill(base);
    await panel.locator("#invitation").fill(invite);
    await panel.evaluate(() => {
      const realRequest = chrome.permissions.request.bind(chrome.permissions);
      chrome.permissions.request = async (request) => {
        window.requestedOrigins = request.origins;
        chrome.permissions.request = realRequest;
        return false;
      };
    });
    await panel.locator("#joinChatter").click();
    await expect(panel.locator("#connectionStatus")).toContainText(
      "許可されませんでした",
    );
    expect(await panel.evaluate(() => window.requestedOrigins)).toEqual([
      "http://127.0.0.1/*",
    ]);
    expect(
      await panel.evaluate(() => chrome.storage.session.get("participant")),
    ).toEqual({});
    await panel.locator("#joinChatter").click();
    await expect(panel.locator("#status")).toContainText("接続しました");
    await expect(panel.locator("#connection")).not.toBeVisible();
    const saved = await panel.evaluate(
      async () => (await chrome.storage.session.get("participant")).participant,
    );
    expect(saved.token).toMatch(/^[a-f0-9]{64}$/);
    expect(await panel.evaluate(() => chrome.storage.local.get())).toEqual({
      bridgeUrl: base,
    });
    expect(panel.url()).not.toContain(saved.token);
    const options = await worker.evaluate(() =>
      chrome.sidePanel.getOptions({}),
    );
    expect(options.path).toBe("panel.html");
    expect(
      (await worker.evaluate(() => chrome.sidePanel.getPanelBehavior()))
        .openPanelOnActionClick,
    ).toBe(true);
    webContext = await browser.newContext();
    const web = await webContext.newPage();
    await web.goto(invite);
    await expect(web.locator("#status")).toContainText("接続しました");
    await panel.locator("#createCharacter").click();
    await panel.locator("#newCharacterName").fill("旅人");
    await panel.locator("#saveNewCharacter").click();
    await expect(panel.locator("#speakingCharacter")).not.toHaveValue("");
    await expect(web.locator("#speakingCharacter option")).toHaveCount(2);
    await panel.locator("#showSettings").click();
    await panel.getByRole("button", { name: "声を選ぶ" }).click();
    const previewResponse = panel.waitForResponse((r) =>
      r.url().endsWith("/previews"),
    );
    await panel.locator("#previewVoice").click();
    const preview = await previewResponse;
    expect(preview.status()).toBe(200);
    expect(preview.headers()["x-preview-id"]).toBeTruthy();
    expect(Number(preview.headers()["content-length"])).toBeGreaterThan(44);
    await expect(panel.locator("#editorStatus")).toContainText(
      "あなたにだけ再生されます",
    );
    await expect
      .poll(() => panel.locator("#previewAudio").evaluate((a) => a.duration))
      .toBeGreaterThan(0);
    await panel.getByRole("button", { name: "保存", exact: true }).click();
    await expect(panel.locator("#characterEditor")).not.toBeVisible();
    await panel.locator("#showChat").click();
    app.engine.accepting = true;
    await panel.locator("#enable").click();
    await panel.evaluate(() => {
      window.started = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (text) {
        const message = JSON.parse(text);
        if (message.type === "playback.started")
          window.started.push(message.orderId);
        return send.call(this, text);
      };
    });
    await panel.locator("#messageText").fill("サイドパネルからこんにちは");
    await panel.locator("#sendMessage").click();
    await expect(web.locator("#log")).toContainText(
      "サイドパネルからこんにちは",
    );
    expect(app.store.chat.list().messages[0].source).toBe("Chatter");
    await expect
      .poll(() => panel.evaluate(() => window.started.length))
      .toBe(1);
    await web.locator("#speakingCharacter").selectOption({ label: "旅人" });
    await web.locator("#messageText").fill("Playerから返事");
    await web.locator("#sendMessage").click();
    await expect(panel.locator("#log")).toContainText("Playerから返事");
    await expect
      .poll(() => panel.evaluate(() => window.started.length))
      .toBe(2);
    expect(app.engine.collectors.size).toBe(0);
    expect(app.store.config.sources).toEqual([]);
    // Open Chrome's actual side panel while a VTT-like page is the main tab.
    const vtt = await context.newPage();
    await vtt.goto(
      "data:text/html,<title>Maps VTT fixture</title><h1>Map</h1>",
    );
    const cdp = await context.browser().newBrowserCDPSession();
    const before = new Set(
      (await cdp.send("Target.getTargets")).targetInfos.map((t) => t.targetId),
    );
    await panel.evaluate(async () =>
      chrome.sidePanel.open({
        windowId: (await chrome.windows.getCurrent()).id,
      }),
    );
    let target;
    await expect
      .poll(async () => {
        target = (await cdp.send("Target.getTargets")).targetInfos.find(
          (t) => !before.has(t.targetId) && t.url.endsWith("/panel.html"),
        );
        return !!target;
      })
      .toBe(true);
    const side = await attachPanel(cdp, target.targetId);
    await expect
      .poll(() =>
        side.evaluate('document.querySelector("#log")?.children.length'),
      )
      .toBe(2);
    expect(
      await side.evaluate('document.querySelector("#enable").textContent'),
    ).toBe("音声を有効にする");
    await side.evaluate(`document.querySelector("#messageText").value = "本物のサイドパネルから";
      document.querySelector("#messageText").dispatchEvent(new Event("input", {bubbles:true}));
      document.querySelector("#sendMessage").click()`);
    await expect(web.locator("#log")).toContainText("本物のサイドパネルから");
    await expect
      .poll(() =>
        side.evaluate('document.querySelector("#log").children.length'),
      )
      .toBe(3);
    expect(
      await side.evaluate(
        'document.querySelector("#sendMessage").getBoundingClientRect().bottom <= innerHeight',
      ),
    ).toBe(true);
    expect(
      await side.evaluate('document.querySelector("#log").clientHeight'),
    ).toBeGreaterThan(80);
    const screenshot = await side.send("Page.captureScreenshot", {
      format: "png",
    });
    writeFileSync(
      test.info().outputPath("side-panel.png"),
      Buffer.from(screenshot.data, "base64"),
    );
    await side.evaluate('document.querySelector("#enable").click()');
    await expect
      .poll(() =>
        side.evaluate('document.querySelector("#enable").textContent'),
      )
      .toBe("音声を停止");
    await cdp.send("Target.closeTarget", { targetId: target.targetId });
    await expect(panel.locator("#enable")).toHaveText("音声を再開する");
    await panel.locator("#enable").click();
    await expect(panel.locator("#enable")).toHaveText("音声を停止");
    await panel.close();
    panel = await context.newPage();
    await panel.goto(`chrome-extension://${id}/panel.html`);
    await expect(panel.locator("#log li")).toHaveCount(3);
    await expect(panel.locator("#enable")).toHaveText("音声を有効にする");
    expect(
      await panel.evaluate(
        async () =>
          (await chrome.storage.session.get("participant")).participant.token,
      ),
    ).toBe(saved.token);
    await panel.locator("#leaveRoom").click();
    await expect(panel.locator("#connection")).toBeVisible();
    expect(
      await panel.evaluate(() => chrome.storage.session.get("participant")),
    ).toEqual({});
    const revoked = await fetch(
      base + `/api/v1/rooms/${initial.roomId}/state`,
      {
        headers: {
          Authorization: `Bearer ${saved.token}`,
          "X-Chatter-Origin": `chrome-extension://${id}`,
        },
      },
    );
    expect(revoked.status).toBe(401);
    await expect(web.locator("#messageText")).toBeEnabled();
    secondApp = createApp({
      initial,
      dataDir: mkdtempSync(join(tmpdir(), "chatter-other-room-")),
      localOrigin: "http://127.0.0.1:0",
    });
    await new Promise((r) => secondApp.server.listen(0, "127.0.0.1", r));
    const secondBase = `http://127.0.0.1:${secondApp.server.address().port}`;
    const secondInvite = await (
      await fetch(secondBase + "/api/v1/admin/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secondApp.store.secrets.admin}`,
        },
        body: JSON.stringify({
          command: "invite",
          commandId: crypto.randomUUID(),
        }),
      })
    ).json();
    // An invitation for a different origin cannot silently switch destinations.
    await panel.locator("#invitation").fill(secondInvite.url);
    await panel.locator("#joinChatter").click();
    await expect(panel.locator("#connectionStatus")).toContainText(
      "接続先が異なります",
    );
    await panel.locator("#bridgeAddress").fill(secondBase);
    await panel.locator("#joinChatter").click();
    await expect(panel.locator("#status")).toContainText("接続しました");
    await expect(panel.locator("#connectionAddress")).toHaveText(secondBase);
    await expect(panel.locator("#log li")).toHaveCount(0);
    await expect(panel.locator("#speakingCharacter option")).toHaveCount(1);
    await context.close();
    context = await chromium.launchPersistentContext(profile, launchOptions);
    panel = await context.newPage();
    await panel.goto(`chrome-extension://${id}/panel.html`);
    await expect(panel.locator("#connection")).toBeVisible();
    await expect(panel.locator("#bridgeAddress")).toHaveValue(secondBase);
    expect(
      await panel.evaluate(() => chrome.storage.session.get("participant")),
    ).toEqual({});
  } finally {
    await context?.close();
    await webContext?.close();
    await app.close();
    await secondApp?.close();
  }
});
