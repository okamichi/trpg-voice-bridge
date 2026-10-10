import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { initialConfig } from "../src/store.mjs";
const source = {
  adapter: "fixture",
  instanceId: "test",
  contextId: "test-world",
};
let app, base, invite;
test.beforeEach(async () => {
  const config = initialConfig(
    JSON.parse(readFileSync(new URL("../profiles.json", import.meta.url))),
  );
  config.provider.type = "mock";
  config.sources = [source];
  config.characters[0].bindings = [{ ...source, speakerId: "melissa" }];
  app = createApp({
    dataDir: mkdtempSync(join(tmpdir(), "trpg-browser-")),
    initial: config,
    localOrigin: "http://127.0.0.1:0",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  app.engine.connect({ source, collectorId: "collector" });
  app.engine.accepting = true;
  invite = (await command("invite")).url;
});
test.afterEach(async () => {
  await app.close();
});
async function admin(path, method = "GET", body) {
  const r = await fetch(base + "/api/v1/admin/" + path, {
    method,
    headers: {
      Authorization: `Bearer ${app.store.secrets.admin}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  expect(r.ok).toBeTruthy();
  return r.json();
}
const command = (command) =>
  admin("commands", "POST", { command, commandId: crypto.randomUUID() });
function post(n) {
  return app.engine.ingress(
    {
      schemaVersion: 1,
      eventId: `event-${n}`,
      roomId: app.engine.config.roomId,
      sessionId: app.engine.sessionId,
      source: { ...source, messageId: `message-${n}`, revision: 0 },
      speaker: { kind: "character", id: "melissa", name: "メリッサ" },
      kind: "dialogue",
      visibility: "public",
      channel: "main",
      text: `こんにちは。その${n}です。`,
      occurredAt: new Date().toISOString(),
    },
    "collector",
  );
}
async function observe(page) {
  await page.addInitScript(() => {
    window.started = [];
    window.activeSounds = 0;
    window.maxSounds = 0;
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      const d = JSON.parse(data);
      if (d.type === "playback.started") {
        window.started.push(d.orderId);
        window.activeSounds++;
        window.maxSounds = Math.max(window.maxSounds, window.activeSounds);
      }
      if (d.type === "playback.ended") window.activeSounds--;
      return orig.call(this, data);
    };
  });
}
test("3 independent players hear 10 ordered messages once; reload ignores old work", async ({
  browser,
}) => {
  const contexts = [],
    pages = [];
  for (let n = 0; n < 3; n++) {
    const c = await browser.newContext();
    contexts.push(c);
    const p = await c.newPage();
    pages.push(p);
    await observe(p);
    await p.goto(invite);
    await expect(p.locator("#status")).toContainText("接続しました");
    await p.getByRole("button", { name: "音声を有効にする" }).click();
  }
  const ids = [];
  for (let n = 0; n < 10; n++) ids.push(post(n).orderId);
  for (const p of pages) {
    await expect.poll(() => p.evaluate(() => window.started.length)).toBe(10);
    expect(await p.evaluate(() => window.started)).toEqual(ids);
    expect(await p.evaluate(() => window.maxSounds)).toBe(1);
  }
  await pages[0].reload();
  await expect(pages[0].locator("#status")).toContainText("接続しました");
  await pages[0].getByRole("button", { name: "音声を有効にする" }).click();
  await pages[0].waitForTimeout(200);
  expect(await pages[0].evaluate(() => window.started)).toEqual([]);
  const id = post(11).orderId;
  await expect
    .poll(() => pages[0].evaluate(() => window.started))
    .toEqual([id]);
  for (const c of contexts) await c.close();
});
test("Player log shows spoken text and replays only on the page that asked", async ({
  browser,
}) => {
  const contexts = [],
    pages = [];
  for (let n = 0; n < 2; n++) {
    const c = await browser.newContext();
    contexts.push(c);
    const p = await c.newPage();
    pages.push(p);
    await observe(p);
    await p.goto(invite);
    await expect(p.locator("#status")).toContainText("接続しました");
    await p.getByRole("button", { name: "音声を有効にする" }).click();
  }
  const ids = [0, 1, 2].map((n) => post(n).orderId);
  for (const p of pages)
    await expect.poll(() => p.evaluate(() => window.started)).toEqual(ids);
  const rows = pages[0].locator("#log li");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("メリッサ");
  await expect(rows.first()).toContainText("その2です。");
  await expect(rows.last()).toContainText("その0です。");
  await rows.last().getByRole("button", { name: "もう一度再生" }).click();
  await expect
    .poll(() => pages[0].evaluate(() => window.started))
    .toEqual([...ids, ids[0]]);
  await pages[1].waitForTimeout(300);
  expect(await pages[1].evaluate(() => window.started)).toEqual(ids);
  await pages[0].reload();
  await expect(pages[0].locator("#status")).toContainText("接続しました");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("その2です。");
  await pages[0].waitForTimeout(200);
  expect(await pages[0].evaluate(() => window.started)).toEqual([]);
  await admin("subtitles", "PUT", {
    before: true,
    publishTextToPlayers: false,
  });
  post(3);
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("メリッサ");
  await expect(rows.first()).not.toContainText("その3です。");
  for (const c of contexts) await c.close();
});
test("Player discovery, shared editing, private preview and conflicts across participants", async ({
  browser,
}) => {
  await command("stop");
  app.store.change((c) => {
    c.characters = [];
  });
  const contexts = [await browser.newContext(), await browser.newContext()];
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    for (const p of pages) {
      await observe(p);
      await p.goto(invite);
      await expect(p.locator("#status")).toContainText("接続しました");
    }
    expect(post("discovery").status).toBe("ignored");
    for (const p of pages)
      await expect(p.locator("#characters")).toContainText("声が未設定");
    await pages[0].getByRole("button", { name: "声を選ぶ" }).click();
    await pages[0].locator("[name=voice]").selectOption("new");
    await pages[0].locator("[name=name]").fill("騎士の声");
    await pages[0].getByRole("button", { name: "自分だけで試聴" }).click();
    await expect(pages[0].locator("#editorStatus")).toContainText(
      "あなたにだけ",
    );
    expect(
      app.engine.history.filter((n) => n.type === "audio.ready"),
    ).toHaveLength(0);
    expect(await pages[1].evaluate(() => window.started)).toEqual([]);
    await pages[0].getByRole("button", { name: "保存", exact: true }).click();
    for (const p of pages)
      await expect(p.locator("#characters")).toContainText("騎士の声");
    for (const p of pages)
      await p.getByRole("button", { name: "試聴・変更" }).click();
    await pages[0].locator("[name=caption]").fill("落ち着いた声");
    await pages[0].getByRole("button", { name: "保存", exact: true }).click();
    await expect(pages[0].locator("#characterEditor")).not.toBeVisible();
    await pages[1].locator("[name=caption]").fill("同時編集");
    await pages[1].getByRole("button", { name: "保存", exact: true }).click();
    await expect(pages[1].locator("#editorStatus")).toContainText(
      "他の人が変更",
    );
    expect(
      app.store.config.voiceProfiles.find((v) => v.name === "騎士の声").caption,
    ).toBe("落ち着いた声");
    await pages[1].getByRole("button", { name: "キャンセル" }).click();
    await pages[0].getByRole("button", { name: "音声を有効にする" }).click();
    await command("start");
    expect(app.engine.orders.size).toBe(0);
    const next = post("after-save");
    await expect
      .poll(() => pages[0].evaluate(() => window.started))
      .toEqual([next.orderId]);
    await pages[0].screenshot({
      path: "verification/player-settings.png",
      fullPage: true,
    });
  } finally {
    for (const c of contexts) await c.close();
  }
});
test("Player deletes only a character registration; shared voices survive and new speech rediscovers it", async ({
  browser,
}) => {
  const old = structuredClone(app.store.config.characters[0]);
  const voices = structuredClone(app.store.config.voiceProfiles);
  app.store.change((c) => {
    c.characters = [
      old,
      {
        ...structuredClone(old),
        id: "companion",
        displayName: "相棒",
        bindings: [{ ...source, speakerId: "companion" }],
      },
    ];
  });
  const contexts = [await browser.newContext(), await browser.newContext()];
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    for (const p of pages) {
      await p.goto(invite);
      await expect(p.locator("#characters .list-item")).toHaveCount(2);
    }
    const row = pages[0]
      .locator("#characters .list-item")
      .filter({ has: pages[0].locator("strong", { hasText: "メリッサ" }) });
    pages[0].once("dialog", (d) => d.dismiss());
    await row.getByRole("button", { name: "削除", exact: true }).click();
    expect(app.store.config.characters).toHaveLength(2);
    pages[0].once("dialog", async (d) => {
      expect(d.message()).toContain("共有している声設定は残ります");
      await d.accept();
    });
    await row.getByRole("button", { name: "削除", exact: true }).click();
    for (const p of pages) {
      await expect(p.locator("#characters .list-item")).toHaveCount(1);
      await expect(p.locator("#characters strong")).toHaveText("相棒");
    }
    expect(app.store.config.voiceProfiles).toEqual(voices);
    expect(app.store.config.characters[0].voiceProfileId).toBe(
      old.voiceProfileId,
    );
    expect(post("rediscover-after-delete").status).toBe("ignored");
    for (const p of pages)
      await expect(p.locator("#characters .list-item")).toHaveCount(2);
    const rediscovered = app.store.config.characters.find(
      (c) => c.id !== "companion",
    );
    expect(rediscovered.id).not.toBe(old.id);
    expect(rediscovered.voiceProfileId).toBeNull();
    await row.getByRole("button", { name: "声を選ぶ" }).click();
    await expect(
      pages[0]
        .locator("select[name=voice] option")
        .filter({ hasText: "メリッサ" }),
    ).toHaveCount(1);
  } finally {
    for (const c of contexts) await c.close();
  }
});
test("management startup link, simplified controls and reset confirmation", async ({
  page,
}) => {
  await page.goto(app.adminUrl());
  await expect(page.locator("#connection")).toContainText("接続済み");
  await page.getByRole("button", { name: "読み上げ停止", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "読み上げ開始", exact: true }),
  ).toBeEnabled();
  expect(app.engine.accepting).toBe(false);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Playerを開く" }).click();
  const player = await popupPromise;
  await expect(player.locator("#characters")).toContainText("メリッサ");
  await page.getByText("詳細設定", { exact: true }).click();
  const publishText = page.getByLabel("Playerにセリフの本文を表示する");
  await expect(publishText).toBeChecked();
  await publishText.uncheck();
  await expect(page.locator("#notice")).toContainText("表示しません");
  expect(app.store.config.publishTextToPlayers).toBe(false);
  await publishText.check();
  await expect(page.locator("#notice")).toContainText("表示します");
  expect(app.store.config.publishTextToPlayers).toBe(true);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "設定を初期値に戻す" }).click();
  await expect(page.locator("#notice")).toContainText("実行しました");
  await page.screenshot({ path: "verification/admin.png", fullPage: true });
});
test("FVTT injected adapter excludes whisper, blind, OOC, rolls and secrets; no render/history hook", async ({
  page,
}) => {
  await page.goto(base + "/player/");
  await page.evaluate(() => {
    window.captured = [];
    window.hooks = {};
    window.game = {
      version: "13.350",
      ready: true,
      world: { id: "world" },
      system: { id: "test", version: "1" },
    };
    window.CONST = { CHAT_MESSAGE_STYLES: { IC: 1, OOC: 0 } };
    window.Hooks = {
      on: (name, fn) => {
        window.hooks[name] = fn;
        return name;
      },
      off: (name) => delete window.hooks[name],
    };
    window.__trpgCollectorSettings = {
      adapter: "fvtt",
      contextId: "world",
      channel: "main",
    };
    window.addEventListener("message", (e) => {
      if (e.data?.channel === "trpg-voice-collector-v1")
        window.captured.push(e.data);
    });
  });
  await page.evaluate(
    readFileSync(new URL("../collector/page.js", import.meta.url), "utf8"),
  );
  await page.evaluate(() => {
    const normal = {
      id: "m1",
      timestamp: Date.now(),
      whisper: [],
      blind: false,
      rolls: [],
      isRoll: false,
      style: 1,
      speaker: { actor: "actor", alias: "メリッサ" },
      alias: "メリッサ",
      content: '<p>こんにちは。<a href="https://example.com">旅人</a>さん</p>',
    };
    const hook = window.hooks.createChatMessage;
    hook(normal);
    hook(normal);
    for (const [i, extra] of [
      { whisper: ["u"] },
      { blind: true },
      { style: 0 },
      { rolls: [{}] },
      { content: '公開<section class="secret">秘密</section>' },
      { content: '<div class="chat-card">アイテム</div>' },
    ].entries())
      hook({ ...normal, id: "private" + i, ...extra });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.captured.filter((m) => m.type === "event").length,
      ),
    )
    .toBe(1);
  const events = await page.evaluate(() =>
    window.captured.filter((m) => m.type === "event"),
  );
  expect(events[0].payload.text).toBe("こんにちは。旅人さん");
  expect(await page.evaluate(() => Object.keys(window.hooks))).toEqual([
    "createChatMessage",
  ]);
});
test("unverified Udonarium and CCFOLIA stop without transmitting chat text", async ({
  page,
}) => {
  for (const adapter of ["udonarium", "ccfolia"]) {
    await page.goto(base + "/player/");
    await page.evaluate((adapter) => {
      window.captured = [];
      window.__trpgCollectorSettings = {
        adapter,
        contextId: "world",
        channel: "main",
      };
      window.addEventListener("message", (e) => {
        if (e.data?.channel === "trpg-voice-collector-v1")
          window.captured.push(e.data);
      });
      document.body.insertAdjacentHTML(
        "beforeend",
        '<chat-tab><chat-message><div class="message"><span class="msg-name">秘密の人</span><span class="msg-text">秘密</span></div></chat-message></chat-tab>',
      );
    }, adapter);
    await page.evaluate(
      readFileSync(new URL("../collector/page.js", import.meta.url), "utf8"),
    );
    await expect
      .poll(() => page.evaluate(() => window.captured.length))
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(() =>
        window.captured.some((x) => x.type === "event"),
      ),
    ).toBe(false);
  }
});

test("real Irodori generates once for repeated input and reaches a browser Player", async ({
  page,
}) => {
  test.skip(
    process.env.TTS_REAL_E2E !== "1",
    "Set TTS_REAL_E2E=1 with Irodori running",
  );
  test.setTimeout(180000);
  app.store.config.provider.type = "irodori";
  let calls = 0;
  app.engine.options.fetchImpl = (...args) => {
    calls++;
    return fetch(...args);
  };
  await observe(page);
  await page.goto(invite);
  await expect(page.locator("#status")).toContainText("接続しました");
  await page.getByRole("button", { name: "音声を有効にする" }).click();
  const e = {
    schemaVersion: 1,
    eventId: "real",
    roomId: app.engine.config.roomId,
    sessionId: app.engine.sessionId,
    source: { ...source, messageId: "real", revision: 0 },
    speaker: { kind: "character", id: "melissa", name: "メリッサ" },
    kind: "dialogue",
    visibility: "public",
    channel: "main",
    text: "ここは私に任せてください。",
    occurredAt: new Date().toISOString(),
  };
  const result = app.engine.ingress(e, "collector");
  for (let n = 0; n < 10; n++)
    expect(app.engine.ingress(e, "collector").orderId).toBe(result.orderId);
  await expect
    .poll(() => page.evaluate(() => window.started), { timeout: 150000 })
    .toEqual([result.orderId]);
  expect(calls).toBe(1);
  await expect(page.locator("#status")).toContainText(
    "次の発言を待っています",
    { timeout: 15000 },
  );
});
