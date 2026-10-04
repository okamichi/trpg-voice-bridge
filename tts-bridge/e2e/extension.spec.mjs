import { test, expect, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { initialConfig } from "../src/store.mjs";
test("MV3 extension connects through isolated relay; stop releases collector lease", async () => {
  const c = initialConfig(
    JSON.parse(readFileSync(new URL("../profiles.json", import.meta.url))),
  );
  c.provider.type = "mock";
  c.sources = [];
  c.characters = [];
  const app = createApp({
    dataDir: mkdtempSync(join(tmpdir(), "trpg-ext-")),
    initial: c,
    localOrigin: "http://127.0.0.1:0",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  app.engine.accepting = true;
  const fixture = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><title>FVTT contract fixture</title><h1>Fixture only</h1>",
    );
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  let context;
  try {
    const extension = new URL("../collector", import.meta.url).pathname;
    context = await chromium.launchPersistentContext(
      mkdtempSync(join(tmpdir(), "trpg-chrome-")),
      {
        channel: "chromium",
        headless: true,
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      },
    );
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const vtt = await context.newPage();
    await vtt.goto(`http://127.0.0.1:${fixture.address().port}/fixture`);
    await vtt.evaluate(() => {
      window.game = {
        version: "14.365",
        ready: true,
        world: { id: "world" },
        system: { id: "fixture", version: "1" },
      };
      window.CONST = { CHAT_MESSAGE_STYLES: { IC: 2 } };
      window.hooks = {};
      window.Hooks = {
        on: (n, f) => {
          hooks[n] = f;
          return n;
        },
        off: (n) => delete hooks[n],
      };
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const bridge = `http://127.0.0.1:${app.server.address().port}`;
    async function reopenPopup() {
      await popup.evaluate(async () => {
        const tab = (await chrome.tabs.query({})).find((x) =>
          x.url?.endsWith("/fixture"),
        );
        await chrome.tabs.update(tab.id, { active: true });
      });
      await popup.reload();
      await expect(popup.locator("#detected")).toHaveText("FVTT / world");
    }
    await reopenPopup();
    await popup.getByText("Bridge接続先", { exact: true }).click();
    await popup.locator("[name=bridge]").fill(bridge);
    await popup.getByRole("button", { name: "このタブを接続" }).click();
    await expect(popup.locator("#status")).toContainText("確認コード:");
    const code = (await popup.locator("#status").textContent()).match(
      /確認コード: ([A-F0-9]+)/,
    )[1];
    const adminPage = await context.newPage();
    await adminPage.goto(app.adminUrl());
    await expect(adminPage.locator("#pairings")).toContainText(code);
    await adminPage.getByRole("button", { name: "承認", exact: true }).click();
    await expect(adminPage.locator("#pairingSection")).not.toBeVisible();
    await reopenPopup();
    await expect(popup.locator("[name=bridge]")).toHaveValue(bridge);
    await popup.getByRole("button", { name: "このタブを接続" }).click();
    await expect(popup.locator("#status")).toContainText("接続しました");
    const settings = await popup.evaluate(
      async () => (await chrome.storage.session.get("active")).active.settings,
    );
    await expect
      .poll(() => vtt.evaluate(() => typeof hooks.createChatMessage))
      .toBe("function");
    await vtt.evaluate(() =>
      hooks.createChatMessage({
        id: "new",
        timestamp: Date.now(),
        whisper: [],
        blind: false,
        rolls: [],
        isRoll: false,
        style: 2,
        speaker: { actor: "actor", alias: "メリッサ" },
        alias: "メリッサ",
        content: "<p>冒険を始めましょう。</p>",
      }),
    );
    await expect.poll(() => app.store.config.characters.length).toBe(1);
    expect(app.store.config.characters[0].voiceProfileId).toBeNull();
    expect(app.store.config.sources[0].instanceId).toBe(settings.instanceId);
    app.store.change((c) => {
      c.characters[0].voiceProfileId = c.voiceProfiles[0].id;
    });
    await vtt.evaluate(() =>
      hooks.createChatMessage({
        id: "configured",
        timestamp: Date.now(),
        whisper: [],
        blind: false,
        rolls: [],
        style: 2,
        speaker: { actor: "actor" },
        alias: "メリッサ",
        content: "こんにちは",
      }),
    );
    await expect
      .poll(() => [...app.engine.orders.values()].map((o) => o.status))
      .toEqual(["ready"]);
    expect(
      await vtt.evaluate(() => JSON.stringify(window.__trpgCollectorSettings)),
    ).not.toContain(settings.token);
    await popup.getByRole("button", { name: "取得を停止" }).click();
    await expect(popup.locator("#status")).toContainText("停止しました");
    expect(app.engine.collectors.size).toBe(0);
    await popup.getByRole("button", { name: "このタブを接続" }).click();
    await expect(popup.locator("#status")).toContainText("接続しました");
    expect(app.engine.collectors.size).toBe(1);
  } finally {
    await context?.close();
    await new Promise((r) => fixture.close(r));
    await app.close();
  }
});
