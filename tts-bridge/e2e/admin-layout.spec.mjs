import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { initialConfig } from "../src/store.mjs";
import { openStep } from "./admin-helpers.mjs";
let app, dataDir;
test.beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "admin-layout-"));
  const initial = initialConfig({});
  initial.provider.type = "mock";
  app = createApp({ dataDir, initial, localOrigin: "http://127.0.0.1:0" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
});
test.afterEach(async ({ context }) => {
  await context.close();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});
async function diagnostics(page, value) {
  await page.route("**/api/v1/admin/diagnostics", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), ...value } });
  });
}
test("steps start closed, pending approvals reopen Collector, copy and session status work", async ({
  page,
  context,
}) => {
  const state = {
    tts: { status: "unreachable" },
    collectors: [
      {
        online: true,
        source: { adapter: "fvtt", contextId: "world" },
        diagnostic: "",
      },
    ],
  };
  let pending = [];
  await diagnostics(page, state);
  await page.route("**/api/v1/admin/pairings", (route) =>
    route.fulfill({ json: pending }),
  );
  await page.clock.install();
  await page.goto(app.adminUrl());
  await expect(page.locator("#toggle")).toBeEnabled();
  await expect(page.locator(".step-num")).toHaveText(["1", "2", "3", "4", "5"]);
  await expect(page.locator(".step-title")).toHaveText([
    "TTSの準備",
    "Collectorの接続",
    "卓の開始",
    "声と読み上げの調整",
    "終了",
    "初期化",
  ]);
  await expect(page.locator("details[open]")).toHaveCount(0);
  await openStep(page, "stepTts");
  await page.locator("#stepTts > summary").click();
  await page.clock.fastForward(5100);
  await expect(page.locator("#stepTts")).not.toHaveAttribute("open");
  pending = [{ id: "pending", code: "123456" }];
  await page.clock.fastForward(5100);
  await expect(page.locator("#collectorState")).toHaveText("承認待ち");
  await expect(page.locator("#stepCollector")).toHaveAttribute("open", "");
  pending = [];
  await page.clock.fastForward(5100);
  await expect(page.locator("#collectorState")).toHaveText("接続中");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator("#copyExtensionsUrl").click();
  await expect(page.locator("#notice")).toContainText(
    "chrome://extensions をコピーしました。",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "chrome://extensions",
  );
  await openStep(page, "stepSession");
  await page.locator("#toggle").click();
  await expect(page.locator("#sessionState")).toHaveText(
    "読み上げ中 ／ 参加者 0 接続",
  );
  await expect(page.locator("#shutdownSection")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const id of ["stepTts", "stepCollector", "stepTuning", "stepReset"])
    await openStep(page, id);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "verification/admin-layout-mobile.png",
    fullPage: true,
  });
});
test("extension failure retains numbered step and connection row order", async ({
  page,
}) => {
  await page.route("**/api/v1/admin/extensions", (route) =>
    route.fulfill({
      json: [
        { id: "discord", title: "Discord Bot", script: "/web/missing.js" },
      ],
    }),
  );
  await page.goto(app.adminUrl());
  await expect(page.locator("#extensions .state")).toHaveText(
    "読み込めませんでした",
  );
  await expect(page.locator("#extensions .state")).toHaveClass("state warn");
  await expect(page.locator("#connectionRows th")).toHaveText([
    "TTSサーバー",
    "Discord Bot",
    "Collector",
    "Player",
  ]);
  await expect(page.locator("#connectionRows tr").nth(1)).toContainText(
    "読み込めませんでした",
  );
  await expect(page.locator(".step-num")).toHaveText([
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
  ]);
  await expect(page.locator(".step-title")).toHaveText([
    "TTSの準備",
    "Discord Bot",
    "Collectorの接続",
    "卓の開始",
    "声と読み上げの調整",
    "終了",
    "初期化",
  ]);
});
test("shutdown notice survives polling and runtime description requires capability", async ({
  page,
}) => {
  let shutdowns = 0;
  await diagnostics(page, { canShutdown: true });
  await page.route("**/api/v1/admin/shutdown", (route) => {
    shutdowns++;
    return route.fulfill({ json: { ok: true } });
  });
  await page.clock.install();
  await page.goto(app.adminUrl());
  await expect(page.locator("#shutdownNote")).toBeHidden();
  await openStep(page, "stepEnd");
  await page.locator("#shutdownSection [data-shutdown]").click();
  await expect(page.locator("#notice")).toContainText(
    "Bridgeを終了しています。",
  );
  await page.route("**/api/v1/admin/diagnostics", (route) => route.abort());
  await page.clock.fastForward(15000);
  await expect(page.locator("#notice")).toContainText(
    "Bridgeを終了しています。",
  );
  expect(shutdowns).toBe(1);
});
