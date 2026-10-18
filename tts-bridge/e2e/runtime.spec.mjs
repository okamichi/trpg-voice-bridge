import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { SpeechRuntime } from "../src/runtime/speech.mjs";

test("bundled runtime UI saves restart settings while keeping active mode and external URL", async ({
  page,
}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "runtime-ui-"));
  const runtime = new SpeechRuntime({
    dataDir,
    runtimeDir: dataDir,
    overrides: { mode: "bundled" },
    backends: ["metal"],
  });
  runtime.fail("GGUFモデルを指定してください");
  const app = createApp({
    dataDir,
    runtime,
    localOrigin: "http://127.0.0.1:0",
    providerOptions: { resolveProvider: (saved) => runtime.provider(saved) },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    const url = app.adminUrl().replace(":0/", `:${app.server.address().port}/`);
    await page.goto(url);
    await page.getByText("詳細設定", { exact: true }).click();
    await expect(page.locator("#runtimeStatus")).toContainText("起動失敗");
    await expect(page.locator("#runtimeStatus")).toContainText(
      "接続先 http://127.0.0.1:18088",
    );
    // The saved mode is external, so the external URL is shown but locked
    // while the active bundled runtime owns the connection.
    await expect(page.locator("#runtimeMode")).toHaveValue("external");
    await expect(page.locator("#providerSection")).toBeVisible();
    await expect(page.locator("#providerNote")).toBeVisible();
    await expect(page.locator("#bundledFields")).toBeHidden();
    await expect(page.locator("#providerUrl")).toBeDisabled();
    await expect(page.locator("#providerUrl")).toHaveValue(
      app.store.config.provider.baseUrl,
    );
    await page
      .locator("#runtimeMode")
      .selectOption({ label: "内蔵speech.cpp" });
    await expect(page.locator("#bundledFields")).toBeVisible();
    await expect(page.locator("#providerSection")).toBeHidden();
    await page.locator("#runtimePort").fill("18123");
    await page.locator("#runtimeMode").selectOption("external");
    await expect(page.locator("#bundledFields")).toBeHidden();
    await expect(page.locator("#providerSection")).toBeVisible();
    await page.getByRole("button", { name: "次回起動の設定を保存" }).click();
    await expect(page.locator("#runtimeStatus")).toContainText("再起動が必要");
    expect(runtime.settings.active.mode).toBe("bundled");
    expect(runtime.settings.saved).toEqual({
      mode: "external",
      model: "",
      ttsPort: 18123,
      backend: "metal",
    });
    await page.reload();
    await page.getByText("詳細設定", { exact: true }).click();
    await expect(page.locator("#runtimePort")).toHaveValue("18123");
    await expect(page.locator("#providerUrl")).toBeDisabled();
  } finally {
    await page.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Windows menu offers the Vulkan and CPU builds and saves the chosen one", async ({
  page,
}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "runtime-ui-windows-"));
  const runtime = new SpeechRuntime({
    dataDir,
    runtimeDir: dataDir,
    overrides: { mode: "bundled" },
    backends: ["vulkan", "cpu"],
  });
  runtime.fail("GGUFモデルを指定してください");
  const app = createApp({
    dataDir,
    runtime,
    localOrigin: "http://127.0.0.1:0",
    providerOptions: { resolveProvider: (saved) => runtime.provider(saved) },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    const url = app.adminUrl().replace(":0/", `:${app.server.address().port}/`);
    await page.goto(url);
    await page.getByText("詳細設定", { exact: true }).click();
    await expect(page.locator("#runtimeStatus")).toContainText(
      "内蔵speech.cpp（Vulkan）",
    );
    await expect(page.locator("#runtimeMode option")).toHaveText([
      "外部サーバー",
      "内蔵speech.cpp（Vulkan）",
      "内蔵speech.cpp（CPU）",
    ]);
    await page
      .locator("#runtimeMode")
      .selectOption({ label: "内蔵speech.cpp（CPU）" });
    await expect(page.locator("#bundledFields")).toBeVisible();
    await page.getByRole("button", { name: "次回起動の設定を保存" }).click();
    await expect(page.locator("#runtimeStatus")).toContainText("再起動が必要");
    expect(runtime.settings.saved).toEqual({
      mode: "bundled",
      model: "",
      ttsPort: 18088,
      backend: "cpu",
    });
    await page.reload();
    await page.getByText("詳細設定", { exact: true }).click();
    await expect(page.locator("#runtimeMode")).toHaveValue("bundled:cpu");
  } finally {
    await page.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
