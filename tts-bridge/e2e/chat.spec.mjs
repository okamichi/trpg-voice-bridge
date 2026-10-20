import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { initialConfig } from "../src/store.mjs";

let app, invite;
test.beforeEach(async () => {
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
  initial.sentenceSplitThresholdChars = 1;
  initial.sentencePauseMs = 0;
  app = createApp({
    dataDir: mkdtempSync(join(tmpdir(), "player-chat-")),
    initial,
    localOrigin: "http://127.0.0.1:0",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const response = await fetch(
    `http://127.0.0.1:${app.server.address().port}/api/v1/admin/commands`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${app.store.secrets.admin}`,
      },
      body: JSON.stringify({
        command: "invite",
        commandId: crypto.randomUUID(),
      }),
    },
  );
  invite = (await response.json()).url;
});
test.afterEach(async ({ context }) => {
  await context.close();
  await app.close();
});
async function create(page, name = "旅人") {
  await expect(page.locator("#status")).toContainText("接続しました");
  await page.getByRole("button", { name: "＋キャラ作成" }).click();
  await page.getByLabel("新しいキャラ名").fill(name);
  await page.getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.locator("#newCharacterDialog")).not.toBeVisible();
  await expect(page.locator("#speakingCharacter")).not.toHaveValue("");
}
async function send(page, text) {
  await page.getByLabel("メッセージ", { exact: true }).fill(text);
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await expect(page.locator("#chatStatus")).toHaveText("送信しました");
}
async function observe(page) {
  await page.addInitScript(() => {
    window.started = [];
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function (text) {
      const message = JSON.parse(text);
      if (message.type === "playback.started")
        window.started.push(message.orderId);
      return original.call(this, text);
    };
  });
}

test("Collector-free chat, character selection, IME, draft, favorites and narrow layout", async ({
  page,
  browser,
}) => {
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(invite);
    await other.goto(invite);
    await create(page);
    await expect(other.locator("#speakingCharacter option")).toHaveCount(2);
    expect(app.store.config.sources).toEqual([]);
    const input = page.getByLabel("メッセージ", { exact: true });
    await input.fill("日本語の確定");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    expect(app.store.chat.list().messages).toHaveLength(0);
    await input.press("Shift+Enter");
    await input.type("二行目");
    await input.press("Enter");
    await expect(other.locator("#log li")).toHaveCount(1);
    await expect(other.locator("#log")).toContainText("二行目");
    await expect(other.locator("#log")).toContainText("読み上げ停止中");
    await expect(page.locator("#enable")).toHaveText("音声を有効にする");
    await create(page, "案内人");
    const selected = await page.locator("#speakingCharacter").inputValue();
    await page.getByRole("button", { name: "☆ お気に入り" }).click();
    await input.fill("保存する下書き");
    await page.reload();
    await expect(input).toHaveValue("保存する下書き");
    await expect(page.locator("#speakingCharacter")).toHaveValue(selected);
    await expect(page.locator("#favoriteCharacter")).toHaveText("★ お気に入り");
    await expect(page.locator("#log li")).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const box = await page.locator("#sendMessage").boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(740);
    await page.screenshot({
      path: "verification/player-chat-mobile.png",
      fullPage: true,
    });
  } finally {
    await otherContext.close();
  }
});

test("unknown delivery retries the same UUID once and preserves draft", async ({
  page,
}) => {
  await page.goto(invite);
  await create(page);
  const payloads = [];
  let first = true;
  await page.route("**/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    payloads.push(route.request().postDataJSON());
    if (first) {
      first = false;
      await route.fetch();
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.locator("#messageText").fill("通信結果が不明な発言");
  await page.locator("#sendMessage").click();
  await expect(page.locator("#retryMessage")).toBeVisible();
  await expect(page.locator("#retryMessage")).toBeEnabled();
  await expect(page.locator("#messageText")).toHaveValue(
    "通信結果が不明な発言",
  );
  await page.locator("#retryMessage").click();
  await expect(page.locator("#chatStatus")).toHaveText("送信しました");
  expect(payloads).toHaveLength(2);
  expect(payloads[0]).toEqual(payloads[1]);
  expect(app.store.chat.list().messages).toHaveLength(1);
});

test("voice settings, one chat row for split speech and local whole-message replay", async ({
  page,
  browser,
}) => {
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    await observe(page);
    await observe(other);
    await page.goto(invite);
    await other.goto(invite);
    await create(page);
    await page.getByRole("tab", { name: "キャラ・声設定" }).click();
    await page.getByRole("button", { name: "声を選ぶ" }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator("#characterEditor")).not.toBeVisible();
    await page.getByRole("tab", { name: "チャット", exact: true }).click();
    app.engine.accepting = true;
    await page.locator("#enable").click();
    await other.locator("#enable").click();
    await send(page, "最初の文です。次の文です。");
    await expect.poll(() => page.evaluate(() => window.started.length)).toBe(2);
    await expect
      .poll(() => other.evaluate(() => window.started.length))
      .toBe(2);
    await expect(page.locator("#log li")).toHaveCount(1);
    const ids = await page.evaluate(() => window.started);
    await page.getByRole("button", { name: "もう一度再生" }).click();
    await expect
      .poll(() => page.evaluate(() => window.started))
      .toEqual([...ids, ...ids]);
    expect(await other.evaluate(() => window.started)).toEqual(ids);
    await page.reload();
    await expect(page.locator("#log li")).toHaveCount(1);
    expect(await page.evaluate(() => window.started)).toEqual([]);
  } finally {
    await otherContext.close();
  }
});

test("sharing changes, pagination, scroll position and leaving", async ({
  page,
}) => {
  await page.goto(invite);
  await create(page);
  const participant = { id: "seed-participant" };
  for (let i = 0; i < 110; i++) {
    app.engine.rate.tokens = 30;
    app.engine.participantMessage(
      {
        characterId: app.store.config.characters[0].id,
        sessionId: app.engine.sessionId,
        clientMessageId: `seed-${i}`,
        text: `履歴 ${i}`,
      },
      participant,
    );
  }
  await page.reload();
  await expect(page.locator("#log li")).toHaveCount(100);
  await page.locator("#loadOlder").click();
  await expect(page.locator("#log li")).toHaveCount(110);
  await page.locator("#log").evaluate((el) => {
    el.scrollTop = 0;
  });
  app.engine.rate.tokens = 30;
  app.engine.participantMessage(
    {
      characterId: app.store.config.characters[0].id,
      sessionId: app.engine.sessionId,
      clientMessageId: "newest",
      text: "新着発言",
    },
    participant,
  );
  await expect(page.locator("#newMessages")).toBeVisible();
  expect(await page.locator("#log").evaluate((el) => el.scrollTop)).toBe(0);
  await page.locator("#newMessages").click();
  await expect(page.locator("#newMessages")).not.toBeVisible();
  app.store.change((c) => {
    c.publishTextToPlayers = false;
    app.store.chat.advanceGenerationInside();
  });
  app.engine.chatPolicyChanged();
  await expect(page.locator("#log li")).toHaveCount(0);
  await expect(page.locator("#sendMessage")).toBeDisabled();
  app.store.change((c) => {
    c.publishTextToPlayers = true;
    app.store.chat.advanceGenerationInside();
  });
  app.engine.chatPolicyChanged();
  await expect(page.locator("#log li")).toHaveCount(100);
  await page.locator("#leaveRoom").click();
  await expect(page.locator("#status")).toContainText("退出しました");
  await expect(page.locator("#log li")).toHaveCount(0);
  await expect(page.locator("#sendMessage")).toBeDisabled();
  const code = await page.evaluate(
    async () => (await fetch("/api/v1/rooms/campaign-01/messages")).status,
  );
  expect(code).toBe(401);
});

test("rejoining keeps an uncertain draft but never automatically resends under a new credential", async ({
  page,
}) => {
  await page.goto(invite);
  await create(page);
  let posts = 0;
  await page.route("**/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    await route.fetch();
    await route.abort("failed");
  });
  await page.locator("#messageText").fill("再参加前の下書き");
  await page.locator("#sendMessage").click();
  await expect(page.locator("#retryMessage")).toBeEnabled();
  await page.goto(invite);
  await expect(page.locator("#status")).toContainText("接続しました");
  await expect(page.locator("#messageText")).toHaveValue("再参加前の下書き");
  await expect(page.locator("#messageText")).toBeEnabled();
  await expect(page.locator("#retryMessage")).toBeHidden();
  await expect(page.locator("#log li")).toHaveCount(1);
  expect(posts).toBe(1);
});

test("reconnect catches up missed chat and clears an offline-deleted history", async ({
  page,
}) => {
  await page.goto(invite);
  await create(page);
  await send(page, "切断前の発言");
  for (const ws of app.wss.clients) ws.terminate();
  app.store.chat.clear();
  app.engine.chatPolicyChanged(true);
  app.engine.rate.tokens = 30;
  app.engine.participantMessage(
    {
      characterId: app.store.config.characters[0].id,
      sessionId: app.engine.sessionId,
      clientMessageId: "offline-message",
      text: "切断中の新しい発言",
    },
    { id: "another-participant" },
  );
  await expect(page.locator("#log li")).toHaveCount(1);
  await expect(page.locator("#log")).toContainText("切断中の新しい発言");
  await expect(page.locator("#log")).not.toContainText("切断前の発言");
  await expect(page.locator("#enable")).toHaveText("音声を有効にする");
});
