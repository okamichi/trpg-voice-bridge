import { openStep } from "./admin-helpers.mjs";
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
    await openStep(page, "stepTts");
    await expect(page.locator("#runtimeStatus")).toContainText("起動失敗");
    await expect(page.locator("#ttsState")).toHaveText("起動失敗");
    await expect(page.locator("#shutdownNote")).toBeHidden();
    await expect(page.locator("#shutdownSection")).toBeHidden();
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
    await openStep(page, "stepTts");
    await expect(page.locator("#runtimePort")).toHaveValue("18123");
    await expect(page.locator("#providerUrl")).toBeDisabled();
  } finally {
    await page.context().close();
    await runtime.close();
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
    onShutdown: () => {},
    localOrigin: "http://127.0.0.1:0",
    providerOptions: { resolveProvider: (saved) => runtime.provider(saved) },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    const url = app.adminUrl().replace(":0/", `:${app.server.address().port}/`);
    await page.goto(url);
    await openStep(page, "stepTts");
    await expect(
      page.locator("#shutdownSection [data-shutdown]"),
    ).toBeVisible();
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
    await expect(page.locator("#restartNotice")).toBeVisible();
    await expect(page.locator("#restartNotice [data-shutdown]")).toBeVisible();
    expect(runtime.settings.saved).toEqual({
      mode: "bundled",
      model: "",
      ttsPort: 18088,
      backend: "cpu",
    });
    await page.reload();
    await openStep(page, "stepTts");
    await expect(page.locator("#runtimeMode")).toHaveValue("bundled:cpu");
  } finally {
    await page.context().close();
    await runtime.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("model downloads resume across reload, apply completion once, cancel and change directory", async ({
  page,
}) => {
  const { resolve } = await import("node:path");
  const dataDir = mkdtempSync(join(tmpdir(), "models-ui-"));
  const runtime = new SpeechRuntime({
    dataDir,
    runtimeDir: resolve(
      ".packaging/native-build",
      process.platform === "win32" ? "Release" : "",
    ),
    speechProgram: [
      process.execPath,
      resolve("packaging/fixtures/model-speech.cjs"),
      dataDir,
    ],
    backends: ["metal"],
    overrides: { mode: "bundled" },
  });
  const app = createApp({
    dataDir,
    runtime,
    localOrigin: "http://127.0.0.1:0",
    credits: {
      entries: [
        {
          title: "TRPG Voice Bridge",
          url: "https://example.org",
          license: "MIT",
        },
        { title: "speech.cpp", url: "https://example.org", license: "MIT" },
      ],
      footer: "",
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    await page.goto(
      app.adminUrl().replace(":0/", `:${app.server.address().port}/`),
    );
    await openStep(page, "stepTts");
    await page.locator("#runtimeMode").selectOption("bundled:metal");
    await expect(page.locator("#modelDir")).toHaveValue(
      join(dataDir, "既定 models"),
    );
    await page.locator("#catalogModel").selectOption("irodori-tts-large:q4_k");
    await expect(page.locator("#catalogLicense")).toBeVisible();
    await page.locator("#catalogModel").selectOption("irodori-tts:q4_k");
    await page.locator("#catalogUse").click();
    await expect(page.locator("#catalogProgressRow")).toBeVisible();
    await page.reload();
    await openStep(page, "stepTts");
    await page.locator("#runtimeMode").selectOption("bundled:metal");
    await expect(page.locator("#runtimeModel")).toHaveValue(
      /irodori-tts-q4_k.gguf$/,
    );
    await page.locator("#runtimeModel").fill(join(dataDir, "manual.gguf"));
    await page.waitForTimeout(5200);
    await expect(page.locator("#runtimeModel")).toHaveValue(
      join(dataDir, "manual.gguf"),
    );
    await page.reload();
    await openStep(page, "stepTts");
    await page.locator("#runtimeMode").selectOption("bundled:metal");
    await expect(page.locator("#catalogModel option")).toHaveCount(8);
    await expect(page.locator("#runtimeModel")).toHaveValue("");
    await expect(page.locator("#catalogStatus")).toBeEmpty();
    await page.locator("#catalogModel").selectOption("irodori-tts:q8_0");
    await page.locator("#catalogUse").click();
    await expect(page.locator("#catalogCancel")).toBeVisible();
    await page.locator("#catalogCancel").click();
    await expect(page.locator("#catalogStatus")).toContainText("中止しました");
    const dir = join(dataDir, "変更 models");
    await page.locator("#modelDir").fill(dir);
    await page.locator("#modelDirSave").click();
    await expect(page.locator("#modelDir")).toHaveValue(dir);
    await expect(page.locator("#catalogUse")).toHaveText(
      "ダウンロードして使う",
    );
    await expect(page.locator("#credits")).not.toHaveAttribute("open");
    await page.locator("#credits summary").click();
    await expect(page.locator("#creditsBody section")).toHaveCount(2);
  } finally {
    await page.context().close();
    await runtime.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("catalog errors preserve manual input and render planned states", async ({
  page,
}, testInfo) => {
  const dataDir = mkdtempSync(join(tmpdir(), "models-scenes-"));
  const runtime = new SpeechRuntime({
    dataDir,
    runtimeDir: dataDir,
    backends: ["metal"],
  });
  runtime.settings.save({ ...runtime.settings.saved, mode: "bundled" });
  const app = createApp({
    dataDir,
    runtime,
    localOrigin: "http://127.0.0.1:0",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const small = {
    choice: "irodori-tts:q8_0",
    label: "Irodori-TTS-v4.1-Small Q8_0",
    size: 1200000000,
    path: join(dataDir, "small.gguf"),
    fetched: false,
    partial: 0,
    gemma: false,
  };
  const large = {
    ...small,
    choice: "irodori-tts-large:q8_0",
    label: "Irodori-TTS-v4-Large Q8_0",
    gemma: true,
  };
  const state = {
    defaultDir: join(dataDir, "models"),
    dir: join(dataDir, "models"),
    models: [small, large],
    pull: null,
  };
  let error = false;
  await page.route("**/api/v1/admin/models", (route) =>
    route.fulfill({
      status: error ? 500 : 200,
      json: error ? { error: "一覧を取得できませんでした。" } : state,
    }),
  );
  try {
    await page.goto(
      app.adminUrl().replace(":0/", `:${app.server.address().port}/`),
    );
    await openStep(page, "stepTts");
    await expect(page.locator("#catalogUse")).toHaveText(
      "ダウンロードして使う",
    );
    await page
      .locator("#runtimeSection")
      .screenshot({ path: testInfo.outputPath("initial.png") });
    await page.locator("#catalogModel").selectOption(large.choice);
    await expect(page.locator("#catalogLicense")).toBeVisible();
    await page
      .locator("#runtimeSection")
      .screenshot({ path: testInfo.outputPath("large.png") });
    state.pull = {
      id: "visual-job",
      choice: small.choice,
      dir: state.dir,
      status: "running",
    };
    small.partial = 450000000;
    await page.reload();
    await openStep(page, "stepTts");
    await expect(page.locator("#catalogProgressRow")).toBeVisible();
    await expect(page.locator("#modelDirSave")).toBeDisabled();
    await page
      .locator("#runtimeSection")
      .screenshot({ path: testInfo.outputPath("running.png") });
    state.pull = {
      ...state.pull,
      status: "error",
      error: "speech: io: test failure",
    };
    await expect(page.locator("#catalogStatus")).toContainText("test failure");
    await page
      .locator("#runtimeSection")
      .screenshot({ path: testInfo.outputPath("error.png") });
    for (const status of ["cancelled", "done"]) {
      state.pull = { ...state.pull, id: status, status: "running" };
      await page.reload();
      await openStep(page, "stepTts");
      await expect(page.locator("#catalogProgressRow")).toBeVisible();
      state.pull = { ...state.pull, status, path: small.path };
      small.fetched = status === "done";
      await expect(page.locator("#catalogStatus")).toContainText(
        status === "done" ? "ダウンロードしました" : "中止しました",
      );
      await page
        .locator("#runtimeSection")
        .screenshot({ path: testInfo.outputPath(`${status}.png`) });
    }
    await page.reload();
    await openStep(page, "stepTts");
    await expect(page.locator("#catalogUse")).toHaveText("このモデルを使う");
    await page
      .locator("#runtimeSection")
      .screenshot({ path: testInfo.outputPath("fetched.png") });
    error = true;
    await page.reload();
    await openStep(page, "stepTts");
    await expect(page.locator("#catalogListError")).toBeVisible();
    await page.locator("#runtimeModel").fill(join(dataDir, "manual.gguf"));
    await expect(page.locator("#runtimeModel")).toBeEditable();
    await page
      .locator("#runtimeSection")
      .screenshot({ path: testInfo.outputPath("list-error.png") });
    await page.locator("#credits summary").click();
    await expect(page.locator("#creditsBody section")).toHaveCount(0);
  } finally {
    await page.context().close();
    await runtime.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("idle catalog stays quiet, hides initial controls, and ignores pre-POST responses", async ({
  page,
}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "models-race-"));
  const runtime = new SpeechRuntime({
    dataDir,
    runtimeDir: dataDir,
    backends: ["metal"],
  });
  runtime.settings.save({ ...runtime.settings.saved, mode: "bundled" });
  const app = createApp({
    dataDir,
    runtime,
    localOrigin: "http://127.0.0.1:0",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const model = {
    choice: "irodori-tts:q8_0",
    label: "Small Q8_0",
    size: 100,
    path: join(dataDir, "done.gguf"),
    fetched: false,
    partial: 0,
  };
  const state = {
    dir: dataDir,
    defaultDir: dataDir,
    models: [model],
    pull: null,
  };
  let requests = 0,
    holdNext = true,
    heldRoute;
  await page.route("**/api/v1/admin/models", async (route) => {
    requests++;
    if (holdNext) {
      holdNext = false;
      heldRoute = route;
      return;
    }
    await route.fulfill({ json: state });
  });
  await page.route("**/api/v1/admin/models/pull", async (route) => {
    state.pull = {
      id: "new-job",
      choice: model.choice,
      dir: dataDir,
      status: "done",
      path: model.path,
    };
    model.fetched = true;
    await route.fulfill({ status: 202, json: { id: "new-job" } });
  });
  try {
    await page.goto(
      app.adminUrl().replace(":0/", `:${app.server.address().port}/`),
    );
    await openStep(page, "stepTts");
    await expect.poll(() => Boolean(heldRoute)).toBe(true);
    await expect(page.locator("#catalogCancel")).toBeHidden();
    await expect(page.locator("#catalogProgressRow")).toBeHidden();
    await expect(page.locator("#catalogUse")).toBeHidden();
    await heldRoute.fulfill({ json: state });
    heldRoute = undefined;
    await expect(page.locator("#catalogUse")).toBeEnabled();
    await page.waitForTimeout(5200);
    expect(requests).toBe(1);
    await page.locator("#runtimeMode").selectOption("external");
    await expect.poll(() => requests).toBe(2);
    await page.waitForTimeout(5200);
    expect(requests).toBe(2);
    holdNext = true;
    await page.locator("#runtimeMode").selectOption("bundled:metal");
    await expect.poll(() => Boolean(heldRoute)).toBe(true);
    const stale = JSON.stringify(state);
    const posted = page.waitForResponse((r) =>
      r.url().endsWith("/models/pull"),
    );
    await page.locator("#catalogUse").click();
    await posted;
    await heldRoute.fulfill({ contentType: "application/json", body: stale });
    heldRoute = undefined;
    await expect(page.locator("#runtimeModel")).toHaveValue(model.path);
    await expect(page.locator("#catalogStatus")).toContainText(
      "ダウンロードしました",
    );
  } finally {
    await page.context().close();
    await runtime.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("corrupt models.json can be repaired using visible directory controls", async ({
  page,
}) => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const dataDir = mkdtempSync(join(tmpdir(), "models-repair-"));
  writeFileSync(join(dataDir, "models.json"), "broken JSON");
  const runtime = new SpeechRuntime({
    dataDir,
    runtimeDir: dataDir,
    backends: ["metal"],
    speechProgram: [
      process.execPath,
      resolve("packaging/fixtures/model-speech.cjs"),
      dataDir,
    ],
  });
  runtime.settings.save({ ...runtime.settings.saved, mode: "bundled" });
  const app = createApp({
    dataDir,
    runtime,
    localOrigin: "http://127.0.0.1:0",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    await page.goto(
      app.adminUrl().replace(":0/", `:${app.server.address().port}/`),
    );
    await openStep(page, "stepTts");
    await expect(page.locator("#catalogListError")).toContainText(
      "models.json",
    );
    await expect(page.locator("#modelDir")).toBeEditable();
    await page.locator("#modelDirReset").click();
    await expect(page.locator("#catalogListError")).toBeHidden();
    await expect(page.locator("#catalogModel option")).toHaveCount(8);
    expect(JSON.parse(readFileSync(join(dataDir, "models.json")))).toEqual({
      dir: "",
    });
  } finally {
    await page.context().close();
    await runtime.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
