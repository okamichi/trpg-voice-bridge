import { openStep } from "./admin-helpers.mjs";
import { test, expect } from "@playwright/test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { SpeechRuntime } from "../src/runtime/speech.mjs";
import { createServer } from "node:http";
import { mockWav } from "../src/provider.mjs";

for (const mode of ["bundled", "external"])
  test(`${mode} speech displays live restoration counts and clears them on completion`, async ({
    page,
  }) => {
    const dataDir = mkdtempSync(join(tmpdir(), "reference-progress-ui-"));
    const names = new Set(["none", "already"]);
    const tts = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/health"
            ? { status: "ok" }
            : {
                data: [
                  {
                    id: "Irodori-TTS",
                    speech: {
                      task: "synthesis",
                      voices: [...names].map((name) => ({ name })),
                      options: [],
                    },
                  },
                ],
              },
        ),
      );
    });
    await new Promise((r) => tts.listen(0, "127.0.0.1", r));
    const runtime = new SpeechRuntime({
      dataDir,
      runtimeDir: dataDir,
      overrides: { mode, ttsPort: tts.address().port },
      backends: ["metal"],
    });
    if (mode === "bundled") runtime.status = "starting";
    const app = createApp({
      dataDir,
      runtime,
      localOrigin: "http://127.0.0.1:0",
      providerOptions: { resolveProvider: (saved) => runtime.provider(saved) },
    });
    app.store.change((c) => {
      c.provider.type = "speech";
      c.provider.baseUrl = `http://127.0.0.1:${tts.address().port}`;
    });
    const provider = app.engine.config.provider,
      refs = mode === "bundled" ? runtime.references : app.engine.references;
    refs.store.save("already", mockWav());
    refs.store.bind("already", provider);
    refs.store.save("new", mockWav());
    refs.store.save("missing", mockWav());
    unlinkSync(join(dataDir, "voices/missing.wav"));
    let release, started, restoring;
    const gate = new Promise((r) => {
        release = r;
      }),
      waiting = new Promise((r) => {
        started = r;
      });
    refs.fetch = async (url, init) => {
      if (init?.method !== "POST") return fetch(url, init);
      started();
      await gate;
      names.add(init.body.get("name"));
      return Response.json({ held: {} });
    };
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    try {
      await page.goto(
        app.adminUrl().replace(":0/", `:${app.server.address().port}/`),
      );
      await openStep(page, "stepTts");
      await expect(page.locator("#ttsState")).toHaveText(
        mode === "bundled" ? "モデル読込中" : "接続済み",
      );
      restoring = refs.prepare(provider);
      await waiting;
      await page.reload();
      await openStep(page, "stepTts");
      await expect(page.locator("#ttsState")).toHaveText(
        "参照音声復元中 1/3 件",
      );
      await expect(page.locator("#referenceProgress")).toHaveText(
        "参照音声復元中 1/3 件",
      );
      await expect(page.locator("#connection")).toContainText(
        "参照音声復元中 1/3 件",
      );
      if (mode === "bundled")
        await expect(page.locator("#runtimeStatus")).toContainText(
          "参照音声復元中 1/3 件",
        );
      release();
      await restoring;
      expect(refs.progress(provider)).toEqual({
        state: "completed",
        completed: 3,
        total: 3,
        failed: 1,
      });
      if (mode === "bundled") runtime.status = "ready";
      await page.reload();
      await openStep(page, "stepTts");
      await expect(page.locator("#ttsState")).toHaveText(
        mode === "bundled" ? "準備完了" : "接続済み",
      );
      await expect(page.locator("#referenceProgress")).toBeHidden();
      await expect(page.locator("#referenceIssues")).toContainText("missing");
    } finally {
      release();
      await restoring?.catch(() => {});
      await page.context().close();
      await app.close();
      await runtime.close();
      await new Promise((r) => tts.close(r));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

test("external native speech selection is saved and diagnostics use its model list", async ({
  page,
}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "native-speech-ui-"));
  let modelsRead = 0;
  const tts = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/health") res.end(JSON.stringify({ status: "ok" }));
    else if (req.url === "/v1/models") {
      modelsRead++;
      res.end(
        JSON.stringify({
          data: [
            {
              id: "Irodori-TTS-v4.1-Anime",
              speech: {
                task: "synthesis",
                voices: [{ name: "none" }, { name: "saved" }],
                options: [],
              },
            },
          ],
        }),
      );
    } else res.end(JSON.stringify({ data: [] }));
  });
  await new Promise((r) => tts.listen(0, "127.0.0.1", r));
  const app = createApp({ dataDir, localOrigin: "http://127.0.0.1:0" });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    await page.goto(
      app.adminUrl().replace(":0/", `:${app.server.address().port}/`),
    );
    await openStep(page, "stepTts");
    await page.locator("#providerType").selectOption("speech");
    await page
      .locator("#providerUrl")
      .fill(`http://127.0.0.1:${tts.address().port}`);
    await page.getByRole("button", { name: "接続先を保存" }).click();
    await expect.poll(() => app.store.config.provider.type).toBe("speech");
    await expect.poll(() => modelsRead).toBeGreaterThan(0);
    await page.reload();
    await openStep(page, "stepTts");
    await expect(page.locator("#providerType")).toHaveValue("speech");
    const response = await page.request.get(
      app
        .adminUrl()
        .replace(":0/", `:${app.server.address().port}/`)
        .split("/admin")[0] + "/api/v1/admin/diagnostics",
      { headers: { Authorization: `Bearer ${app.store.secrets.admin}` } },
    );
    expect((await response.json()).tts.model).toBe("Irodori-TTS-v4.1-Anime");
    app.engine.references.store.save("saved", mockWav());
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const headers = {
      Authorization: `Bearer ${app.store.secrets.admin}`,
      "Content-Type": "application/json",
    };
    const listed = await fetch(
      `${base}/api/v1/admin/providers/irodori-local/voices`,
      { headers },
    );
    expect((await listed.json()).map((v) => v.id)).toEqual(["none"]);
    const [issue] = app.engine.references.diagnostics(
      app.engine.config.provider,
    );
    const body = {
      action: "adopt",
      id: issue.id,
      sha256: issue.sha256,
      before: app.engine.config.provider,
      confirm: true,
    };
    const resolve = (data, h = headers) =>
      fetch(`${base}/api/v1/admin/reference-voices/resolve`, {
        method: "POST",
        headers: h,
        body: JSON.stringify(data),
      });
    expect([401, 403]).toContain(
      (await resolve(body, { "Content-Type": "application/json" })).status,
    );
    expect((await resolve({ ...body, confirm: false })).status).toBe(422);
    expect((await resolve({ ...body, before: {} })).status).toBe(409);
    await page.reload();
    await expect(page.locator("#referenceRecovery")).toBeVisible();
    await expect(page.locator("#referenceIssues")).toContainText("saved");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("button", { name: "同じ音声と確認して紐付け" })
      .click();
    expect(
      app.engine.references.store.bound("saved", app.engine.config.provider),
    ).toBe(false);
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "同じ音声と確認して紐付け" })
      .click();
    await expect(page.locator("#referenceRecovery")).toBeHidden();
    expect(
      app.engine.references.store.bound("saved", app.engine.config.provider),
    ).toBe(true);
    unlinkSync(join(dataDir, "voices/saved.wav"));
    await page.reload();
    await expect(page.locator("#referenceIssues")).toContainText(
      "WAVがありません",
    );
    const listedWithoutBackup = await fetch(
      `${base}/api/v1/admin/providers/irodori-local/voices`,
      { headers },
    );
    expect((await listedWithoutBackup.json()).map((v) => v.id)).toContain(
      "saved",
    );
    const forget = { ...body, action: "forget" };
    expect((await resolve({ ...forget, confirm: false })).status).toBe(422);
    expect((await resolve({ ...forget, sha256: "stale" })).status).toBe(409);
    expect((await resolve({ ...forget, before: {} })).status).toBe(409);
    expect([401, 403]).toContain(
      (await resolve(forget, { "Content-Type": "application/json" })).status,
    );
    page.once("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("button", { name: "管理対象から外す", exact: true })
      .click();
    expect(
      Object.hasOwn(app.engine.references.store.read().voices, "saved"),
    ).toBe(true);
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "管理対象から外す", exact: true })
      .click();
    await expect(page.locator("#referenceRecovery")).toBeHidden();
    expect(
      Object.hasOwn(app.engine.references.store.read().voices, "saved"),
    ).toBe(false);
    const ledger = join(dataDir, "reference-voices.json"),
      backup = readFileSync(ledger, "utf8");
    writeFileSync(ledger, "{ broken");
    const diagnosis = await fetch(`${base}/api/v1/admin/diagnostics`, {
      headers,
    });
    expect(diagnosis.status).toBe(200);
    const state = await diagnosis.json();
    expect(state.tts.model).toBe("Irodori-TTS-v4.1-Anime");
    expect(state.referenceVoices[0].kind).toBe("ledger");
    await page.reload();
    await expect(page.locator("#referenceIssues")).toContainText(
      "reference-voices.json",
    );
    await expect(page.locator("#connection")).toContainText("接続済み");
    expect(readFileSync(ledger, "utf8")).toBe("{ broken");
    writeFileSync(ledger, backup);
    await page.reload();
    await expect(page.locator("#referenceRecovery")).toBeHidden();
  } finally {
    await page.context().close();
    await app.close();
    await new Promise((r) => tts.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

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
    await expect(page.locator("#providerType")).toBeDisabled();
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
      stt: { enabled: false, model: "", logDir: "" },
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
    await expect(page.locator("details[open]")).toHaveCount(0);
    await openStep(page, "stepTts");
    await openStep(page, "stepEnd");
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
      stt: { enabled: false, model: "", logDir: "" },
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
  const runtimeDir = resolve(
    ".packaging/native-build",
    process.platform === "win32" ? "Release" : "",
  );
  test.skip(
    !existsSync(
      join(
        runtimeDir,
        `bridge-supervisor${process.platform === "win32" ? ".exe" : ""}`,
      ),
    ),
    "Run npm run package:speech to build bridge-supervisor",
  );
  const dataDir = mkdtempSync(join(tmpdir(), "models-ui-"));
  const runtime = new SpeechRuntime({
    dataDir,
    runtimeDir,
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
