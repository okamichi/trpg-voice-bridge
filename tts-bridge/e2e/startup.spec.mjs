import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../src/runtime/launcher.mjs";
import { StartupSettings, launchOverrides } from "../src/runtime/startup.mjs";
import { initialConfig } from "../src/store.mjs";
import { openStep } from "./admin-helpers.mjs";

async function unusedPort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

let handle, dir;
async function start({ env = {}, saved, fail } = {}) {
  dir = mkdtempSync(join(tmpdir(), "startup-ui-"));
  const port = await unusedPort();
  const file = join(dir, "startup.json");
  if (saved) writeFileSync(file, JSON.stringify(saved));
  const defaults = {
    dataDir: join(dir, "data"),
    host: "127.0.0.1",
    port,
    publicOrigin: "",
  };
  handle = await startBridge({
    startup: new StartupSettings({ file, defaults, ...launchOverrides(env) }),
    boot: (active) => {
      if (fail?.(active)) throw Error("boot failed");
      const initial = initialConfig({});
      initial.provider.type = "mock";
      return { initial, localOrigin: `http://127.0.0.1:${active.port}` };
    },
  });
  return { port, file, defaults };
}
test.afterEach(async ({ context }) => {
  await context.close();
  await handle?.stop();
  handle = undefined;
  rmSync(dir, { recursive: true, force: true });
});
function acceptDialogs(page) {
  const messages = [];
  page.on("dialog", (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  return messages;
}

test("step 0 shows the settings and moves the page to the new port after a restart", async ({
  page,
}) => {
  const { port, file, defaults } = await start({
    env: { TTS_PUBLIC_ORIGIN: "" },
  });
  const messages = acceptDialogs(page);
  await page.goto(handle.app.adminUrl());
  await expect(page.locator("#stepStartup")).toBeVisible();
  // Step 0 keeps the numbers of the other steps.
  await expect(page.locator(".step-num")).toHaveText([
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
  await expect(page.locator(".step-title").first()).toHaveText("起動設定");
  await expect(page.locator("#stepStartup")).not.toHaveAttribute("open");
  await expect(page.locator("#startupState")).toHaveText(`127.0.0.1:${port}`);
  await page.locator("#stepStartup > summary").click();
  await expect(page.locator("#startupDataDir")).toHaveValue("");
  await expect(page.locator("#startupDataDir")).toHaveAttribute(
    "placeholder",
    defaults.dataDir,
  );
  await expect(page.locator("#startupHost")).toHaveValue("127.0.0.1");
  await expect(page.locator("#startupPort")).toHaveValue(String(port));
  await expect(page.locator("#startupPublicOrigin")).toBeDisabled();
  await expect(page.locator("#startupPublicOriginNote")).toHaveText(
    "環境変数 TTS_PUBLIC_ORIGINで指定中のため、ここでは変更できません。",
  );
  await expect(page.locator("#startupFile")).toHaveText(
    `設定ファイル: ${file}`,
  );
  const next = await unusedPort();
  await page.locator("#startupPort").fill(String(next));
  await page.getByRole("button", { name: "保存して再起動" }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:${next}/admin/`);
  await expect(page.locator("#notice")).toHaveText("Bridgeを再起動しました。");
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("ポートを変えると");
  expect(messages[0]).not.toContain("保存先を変えると");
  await expect(page.locator("#startupState")).toHaveText(`127.0.0.1:${next}`);
  await page.locator("#stepStartup > summary").click();
  await expect(page.locator("#startupPort")).toHaveValue(String(next));
  await expect(page.locator("#toggle")).toBeEnabled();
});

test("reset returns to the defaults on the same page", async ({ page }) => {
  const saved = await unusedPort();
  const { port } = await start({
    saved: { port: saved, host: "0.0.0.0", publicOrigin: "http://192.0.2.1" },
  });
  acceptDialogs(page);
  await page.goto(handle.app.adminUrl());
  await page.locator("#stepStartup > summary").click();
  await expect(page.locator("#startupHost")).toHaveValue("0.0.0.0");
  await expect(page.locator("#startupPublicOrigin")).toHaveValue(
    "http://192.0.2.1",
  );
  await page.getByRole("button", { name: "設定初期化" }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:${port}/admin/`);
  await expect(page.locator("#notice")).toHaveText("Bridgeを再起動しました。");
  await page.locator("#stepStartup > summary").click();
  await expect(page.locator("#startupHost")).toHaveValue("127.0.0.1");
  await expect(page.locator("#startupPublicOrigin")).toHaveValue("");
});

test("a failed restart comes back on the old settings and explains why", async ({
  page,
}) => {
  const next = await unusedPort();
  const { port } = await start({ fail: (active) => active.port === next });
  acceptDialogs(page);
  await page.goto(handle.app.adminUrl());
  await page.locator("#stepStartup > summary").click();
  await page.locator("#startupPort").fill(String(next));
  await page.getByRole("button", { name: "保存して再起動" }).click();
  await expect(page.locator("#notice")).toContainText("元の設定で起動しました");
  expect(new URL(page.url()).port).toBe(String(port));
  await expect(page.locator("#stepStartup")).not.toHaveAttribute("open");
  await openStep(page, "stepStartup");
  await expect(page.locator("#startupError")).toContainText(
    "元の設定で起動しました",
  );
  await expect(page.locator("#startupPort")).toHaveValue(String(port));
  await expect(page.locator("#startupState")).toHaveClass("state warn");
});

test("saved TTS settings offer a restart instead of quitting", async ({
  page,
}) => {
  await start();
  const runtime = {
    active: { mode: "external", model: "", ttsPort: 18088, backend: "metal" },
    saved: { mode: "bundled", model: "", ttsPort: 18088, backend: "metal" },
    backends: ["metal"],
    status: "external",
    error: "",
    restartRequired: true,
  };
  await page.route("**/api/v1/admin/diagnostics", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), runtime, canShutdown: true },
    });
  });
  await page.route("**/api/v1/admin/models", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  const messages = acceptDialogs(page);
  await page.goto(handle.app.adminUrl());
  await openStep(page, "stepTts");
  await expect(page.locator("#restartNotice")).toBeVisible();
  await expect(page.locator("#restartNoticeRestart")).toBeVisible();
  await expect(page.locator("#restartNoticeShutdown")).toBeHidden();
  await expect(page.locator("#restartNotice [data-shutdown]")).toBeHidden();
  const before = handle.app;
  await page.locator("#runtimeRestart").click();
  await expect(page.locator("#notice")).toHaveText("Bridgeを再起動しました。");
  expect(messages[0]).toContain("TTSの起動設定を反映します");
  expect(handle.app).not.toBe(before);
});
