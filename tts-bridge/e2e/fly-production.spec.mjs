import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const flyCode = readFileSync(
  new URL("../collector/fly.js", import.meta.url),
  "utf8",
);
const pageCode = readFileSync(
  new URL("../collector/page.js", import.meta.url),
  "utf8",
);

test("Fly production models work without Angular debug APIs", async ({
  page,
}) => {
  test.skip(process.env.TTS_FLY_E2E !== "1");
  await page.goto("https://withfly.onlinesession.app/");
  await page.getByText("チャット画面", { exact: true }).click();
  await expect(page.locator("chat-tab").first()).toBeVisible();
  await page.evaluate(flyCode);
  const result = await page.evaluate(async () => {
    const original = Map.prototype.get;
    window.flyModel = await window.__trpgFly.capture("MainTab");
    window.flyOriginalCallback = flyModel.tab.onChildAdded;
    return {
      id: flyModel.tab.identifier,
      name: flyModel.tab.name,
      ng: typeof window.ng?.getComponent,
      restored: Map.prototype.get === original,
    };
  });
  expect(result.id).toBe("MainTab");
  expect(result.ng).toBe("undefined");
  expect(result.restored).toBe(true);
  await page.evaluate(() => {
    flyModel.tab.addMessage({
      from: "test-user",
      name: "キャラクターA",
      characterIdentifier: "testCharacter_4",
      text: "接続前の履歴",
      timestamp: Date.now(),
    });
    window.collectorEvents = [];
    window.addEventListener("message", (e) => {
      if (e.data?.channel === "trpg-voice-collector-v1")
        collectorEvents.push(e.data);
    });
    window.__trpgCollectorSettings = {
      adapter: "udonarium",
      variant: "fly",
      channel: "MainTab",
      contextId: "test-room",
    };
  });
  await page.evaluate(pageCode);
  expect(await page.evaluate(() => window.__trpgCollectorReady)).toEqual({
    ok: true,
  });
  const expected = await page.evaluate(() => {
    const base = {
      from: "test-user",
      name: "同名キャラ",
      characterIdentifier: "testCharacter_4",
      text: "同じセリフ",
      timestamp: Date.now(),
    };
    const secret = flyModel.tab.addMessage({
      ...base,
      text: "秘密",
      tag: "secret",
    });
    // Disclose synchronously, before the next browser task/polling tick.
    secret.tag = "";
    for (const overrides of [
      { to: "other-user", text: "DM" },
      { tag: "direct", text: "directタグ" },
      { tag: "system", text: "システム" },
      { tag: "opelog", text: "操作ログ" },
      { characterIdentifier: "", text: "プレイヤー" },
      { timestamp: 1, text: "過去ログ追加" },
    ])
      flyModel.tab.addMessage({ ...base, ...overrides });
    flyModel.get("SubTab").addMessage({ ...base, text: "対象外タブ" });
    return [
      flyModel.tab.addMessage(base),
      flyModel.tab.addMessage({
        ...base,
        characterIdentifier: "testCharacter_5",
      }),
    ].map((m) => ({ id: m.identifier, speaker: m.characterIdentifier }));
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => collectorEvents.filter((e) => e.type === "event").length,
      ),
    )
    .toBe(2);
  expect(
    await page.evaluate(() =>
      collectorEvents
        .filter((e) => e.type === "event")
        .map((e) => ({
          id: e.payload.messageId,
          speaker: e.payload.speaker.id,
        })),
    ),
  ).toEqual(expected);
  // Wait over multiple polls: revealing a secret cannot publish it retroactively.
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(
      () => collectorEvents.filter((e) => e.type === "event").length,
    ),
  ).toBe(2);
  await page.evaluate(() => window.__trpgCollectorStop());
  expect(
    await page.evaluate(
      () => flyModel.tab.onChildAdded === flyOriginalCallback,
    ),
  ).toBe(true);
});
