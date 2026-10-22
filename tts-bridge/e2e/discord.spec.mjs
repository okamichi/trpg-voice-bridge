import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { initialConfig } from "../src/store.mjs";
import { createExtension } from "../discord/extension.mjs";
const A = "11111111111111111";
let app, dir, calls;
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "discord-browser-"));
  calls = [];
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
  initial.provider.type = "mock";
  app = createApp({
    dataDir: dir,
    initial,
    localOrigin: "http://127.0.0.1:0",
    extensions: [
      (ctx) =>
        createExtension({
          ...ctx,
          log: () => {},
          installed: true,
          botFactory: async () => {
            calls.push("login");
            let state = "logged-in";
            return {
              status: () => ({
                state,
                botName: "Test Bot",
                inviteUrl: "https://discord.com/test",
              }),
              channels: async () => [
                {
                  guildId: A,
                  channelId: A,
                  guildName: "TRPGサーバー",
                  channelName: "一般",
                  canSpeak: true,
                },
                {
                  guildId: A,
                  channelId: "22222222222222222",
                  guildName: "TRPGサーバー",
                  channelName: "控室",
                  canSpeak: false,
                },
              ],
              textChannels: async () => [
                {
                  guildId: A,
                  channelId: "33333333333333333",
                  guildName: "TRPGサーバー",
                  channelName: "ブリッジ声登録",
                  canSend: true,
                },
              ],
              cancelDesigns: () => calls.push("cancel-designs"),
              connect: async () => {
                state = "connected";
                calls.push("connect");
              },
              disconnect: async () => {
                state = "logged-in";
                calls.push("disconnect");
              },
              close: async () => {
                calls.push("close");
              },
            };
          },
        }),
    ],
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
});
test.afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});
test("Discord voice design is opt-in and saves a separate text destination without joining voice", async ({
  page,
}) => {
  await page.goto(app.adminUrl());
  const panel = page.locator("#extensions");
  await panel.locator("details.step > summary").click();
  await expect(
    panel.getByLabel("登録コマンドで試聴フォームを開く"),
  ).not.toBeChecked();
  await panel.getByLabel("Discord Botに接続する").check();
  await panel.getByLabel("Botトークン").fill("test-token");
  await panel.getByRole("button", { name: "保存してログイン" }).click();
  await expect(
    panel.getByLabel("専用テキストチャンネル").locator("option"),
  ).toHaveCount(2);
  await panel
    .getByLabel("専用テキストチャンネル")
    .selectOption(`${A}/33333333333333333`);
  await panel.getByLabel("登録コマンドで試聴フォームを開く").check();
  await panel.getByRole("button", { name: "試聴モードを保存" }).click();
  await expect(panel.locator("[data-id=notice]")).toHaveText("完了しました");
  expect(calls).toContain("cancel-designs");
  expect(calls).not.toContain("connect");
  await page.reload();
  await panel.locator("details.step > summary").click();
  await expect(
    panel.getByLabel("登録コマンドで試聴フォームを開く"),
  ).toBeChecked();
  await expect(panel.getByLabel("専用テキストチャンネル")).toHaveValue(
    `${A}/33333333333333333`,
  );
});
test("admin can configure, connect, preview and delete token without exposing it", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.adminUrl());
  const panel = page.locator("#extensions");
  const connections = page.getByRole("table", { name: "接続状態" });
  await expect(connections.getByRole("row")).toHaveCount(4);
  await expect(
    connections.getByRole("row", { name: /^TTSサーバー/ }),
  ).toContainText("Irodori-TTS: 接続済み ／ 読み上げ停止中");
  await expect(
    connections.getByRole("row", { name: /^Collector/ }),
  ).toContainText("未接続");
  await expect(connections.getByRole("row", { name: /^Player/ })).toContainText(
    "参加者 0 接続",
  );
  await expect(
    connections.getByRole("row", { name: /^Discord Bot/ }),
  ).toContainText("未使用");
  await expect(panel.locator(".state")).toHaveText("未使用");
  await expect(panel.getByLabel("Discord Botに接続する")).toBeHidden();
  await panel.locator("details.step > summary").click();
  await expect(panel.getByLabel("Discord Botに接続する")).not.toBeChecked();
  await expect(panel.getByLabel("Botトークン")).toBeVisible();
  await panel.getByLabel("Discord Botに接続する").check();
  await expect(panel.getByLabel("Botトークン")).toBeVisible();
  await expect(panel.locator("[data-id=tokenSet]")).toHaveText("未設定");
  await expect(
    panel.getByRole("button", { name: "保存してログイン" }),
  ).toBeEnabled();
  await panel.getByLabel("Botトークン").fill("test-private-token");
  await panel.getByRole("button", { name: "保存してログイン" }).click();
  await expect(panel.locator("[data-id=status]")).toHaveText("ログイン済み");
  await expect(panel.getByLabel("Botトークン")).toHaveValue("");
  await panel.getByLabel("ボイスチャンネル").selectOption(`${A}/${A}`);
  await expect(
    panel.getByRole("button", { name: "接続", exact: true }),
  ).toBeEnabled();
  await expect(
    panel.getByRole("option", {
      name: "TRPGサーバー / 控室（権限がありません）",
    }),
  ).toHaveJSProperty("disabled", true);
  await panel.getByRole("button", { name: "接続", exact: true }).click();
  await expect(panel.locator(".state")).toHaveText(
    "TRPGサーバー / 一般 — 接続済み",
  );
  await expect(panel.locator(".state")).toHaveClass("state ok");
  await expect(panel.locator("[data-id=status]")).toHaveText("接続済み");
  await panel.locator("details.step > summary").click();
  await expect(panel.getByLabel("Botトークン")).toBeHidden();
  await expect(
    connections.getByRole("row", { name: /^Discord Bot/ }),
  ).toContainText("TRPGサーバー / 一般 — 接続済み");
  await panel.locator("details.step > summary").click();
  await panel
    .getByRole("combobox", { name: "声", exact: true })
    .selectOption("voice");
  await panel.getByRole("button", { name: "メッセージを保存" }).click();
  await expect(panel.getByRole("button", { name: "入室を試聴" })).toBeEnabled();
  await panel.getByRole("button", { name: "入室を試聴" }).click();
  await expect(panel.locator("audio")).toBeVisible();
  await expect(panel.locator("[data-id=notice]")).toHaveText("完了しました");
  expect(calls.filter((c) => c === "connect")).toHaveLength(1);
  await panel.getByRole("button", { name: "切断", exact: true }).click();
  await expect(panel.locator("[data-id=status]")).toHaveText("ログイン済み");
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "トークンを削除" }).click();
  await expect(panel.locator("[data-id=tokenSet]")).toHaveText("未設定");
  expect(await panel.textContent()).not.toContain("test-private-token");
  expect(errors).toEqual([]);
});

test("disclosure is independent of the connection checkbox and unsaved greeting voice is clearly marked", async ({
  page,
}) => {
  await page.goto(app.adminUrl());
  const panel = page.locator("#extensions"),
    details = panel.locator("details.step");
  const enabled = panel.getByLabel("Discord Botに接続する");
  await expect(details).not.toHaveAttribute("open");
  await panel.locator("details.step > summary").click();
  await enabled.check();
  await expect(details).toHaveAttribute("open", "");
  await expect(
    panel.getByRole("combobox", { name: "声", exact: true }),
  ).toHaveValue("");
  await expect(panel.locator("[data-id=greetingStatus]")).toContainText(
    "保存または接続すると音声を生成します",
  );
  await panel
    .getByRole("combobox", { name: "声", exact: true })
    .selectOption("voice");
  await expect(panel.locator("[data-id=greetingStatus]")).toContainText(
    "変更は未保存",
  );
  await panel.getByRole("button", { name: "メッセージを保存" }).click();
  await expect(panel.locator("[data-id=greetingStatus]")).toContainText(
    "入室: 音声の準備済み",
  );
  await expect(panel.locator("[data-id=greetingStatus]")).toContainText(
    "退出: 音声の準備済み",
  );
  await panel.locator("details.step > summary").press("Enter");
  await expect(details).not.toHaveAttribute("open");
  await expect(enabled).toBeChecked();
  await expect(enabled).toBeHidden();
  // A status refresh must not reopen a panel the user collapsed.
  await page.waitForTimeout(5200);
  await expect(details).not.toHaveAttribute("open");
  await panel.locator("details.step > summary").click();
  await enabled.uncheck();
  await expect(details).toHaveAttribute("open", "");
  await expect(enabled).not.toBeChecked();
  await enabled.check();
  await expect(details).toHaveAttribute("open", "");
});

test("default narrator can be previewed and saved with no registered voice selected", async ({
  page,
}) => {
  const previews = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/admin/previews"))
      previews.push(request.postDataJSON());
  });
  await page.goto(app.adminUrl());
  const panel = page.locator("#extensions");
  await panel.locator("details.step > summary").click();
  await panel.getByLabel("Discord Botに接続する").check();
  await expect(
    panel.getByRole("combobox", { name: "声", exact: true }),
  ).toHaveValue("");
  await panel.getByRole("button", { name: "入室を試聴" }).click();
  await expect(panel.locator("audio")).toBeVisible();
  expect(previews[0].voice.caption).toBe(
    "聞き取りやすい若い女性ナレーターの声",
  );
  expect(previews[0].voice.voiceId).toBe("none");
  await panel.getByRole("button", { name: "メッセージを保存" }).click();
  await expect(panel.locator("[data-id=greetingStatus]")).toContainText(
    "音声の準備済み",
  );
  await page.reload();
  await expect(panel.getByLabel("Botトークン")).toBeHidden();
  await panel.locator("details.step > summary").click();
  await expect(panel.getByLabel("Discord Botに接続する")).toBeChecked();
  await expect(
    panel.getByRole("combobox", { name: "声", exact: true }),
  ).toHaveValue("");
  await expect(panel.getByLabel("Botトークン")).toBeVisible();
});
