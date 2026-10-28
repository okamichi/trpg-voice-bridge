import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { SpeechRuntime } from "../src/runtime/speech.mjs";
import { chatterFiles } from "../chatter/files.mjs";
import { zipFiles } from "../chatter/zip.mjs";
import { openStep } from "./admin-helpers.mjs";

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "stt-ui-"));
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
  app.store.change((config) => {
    config.provider.type = "mock";
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    runtime,
    dataDir,
    base,
    adminUrl: app.adminUrl().replace(":0/", `:${app.server.address().port}/`),
    async close() {
      await app.close();
      await runtime.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("STT settings validate, preserve drafts, and disable recognition for external mode", async ({
  page,
}) => {
  const f = await fixture();
  let save;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/v1/admin/models", (route) =>
    route.fulfill({
      json: { models: [], dir: f.dataDir, defaultDir: f.dataDir },
    }),
  );
  await page.route("**/api/v1/admin/runtime", async (route) => {
    save = route.request().postDataJSON();
    await route.fulfill({ json: {} });
  });
  await page.route("**/api/v1/admin/diagnostics", async (route) => {
    const data = await (await route.fetch()).json();
    data.runtime.stt = { enabled: true, status: "ready", error: "" };
    data.runtime.transcription = {
      enabled: true,
      count: 12,
      path: "/logs/transcript.jsonl",
      error: "disk full",
    };
    await route.fulfill({ json: data });
  });
  try {
    await page.goto(f.adminUrl);
    await openStep(page, "stepTts");
    await expect(page.locator("#sttFields")).toBeVisible();
    await expect(page.locator("#sttEnabled")).not.toBeChecked();
    await expect(page.locator("#runtimeStatus")).toContainText(
      "文字起こし：準備完了",
    );
    await expect(page.locator("#runtimeStatus")).toContainText(
      "/logs/transcript.jsonl",
    );
    await expect(page.locator("#runtimeStatus")).toContainText(
      "文字起こしのファイルを書き出せません",
    );
    await page.locator("#sttEnabled").check();
    await page.getByRole("button", { name: "次回起動の設定を保存" }).click();
    await expect(page.locator("#notice")).toHaveText(
      "STTモデルを指定してください",
    );
    expect(save).toBeUndefined();
    await page.locator("#sttModel").fill("/models/asr.gguf");
    await page.locator("#sttLogDir").fill("relative/logs");
    await page.getByRole("button", { name: "次回起動の設定を保存" }).click();
    await expect(page.locator("#notice")).toContainText("絶対パス");
    expect(save).toBeUndefined();
    await page.locator("#sttLogDirReset").click();
    await expect(page.locator("#sttLogDir")).toHaveValue("");
    await page.getByRole("button", { name: "次回起動の設定を保存" }).click();
    await expect
      .poll(() => save?.stt)
      .toEqual({ enabled: true, model: "/models/asr.gguf", logDir: "" });
    await page.waitForTimeout(5200);
    await expect(page.locator("#sttEnabled")).toBeChecked();
    await expect(page.locator("#sttModel")).toHaveValue("/models/asr.gguf");
    await page.locator("#runtimeMode").selectOption("external");
    await expect(page.locator("#sttFields")).toBeHidden();
    await page.getByRole("button", { name: "次回起動の設定を保存" }).click();
    await expect.poll(() => save?.stt.enabled).toBe(false);
    expect(save.stt.model).toBe("/models/asr.gguf");
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
    await f.close();
  }
});

test("STT and TTS share one download, recover on reload, and apply only their own completed path once", async ({
  page,
}) => {
  const f = await fixture();
  const models = [
    {
      task: "synthesis",
      choice: "irodori-tts:q8_0",
      label: "Irodori Q8_0",
      size: 100,
      partial: 0,
      fetched: false,
      path: "/models/tts.gguf",
    },
    {
      task: "recognition",
      choice: "qwen3-asr-0.6b:q8_0",
      label: "Qwen3-ASR Q8_0",
      size: 100,
      partial: 25,
      fetched: false,
      path: "/models/asr.gguf",
    },
  ];
  const state = { models, dir: f.dataDir, defaultDir: f.dataDir, pull: null };
  let jobs = 0;
  await page.route("**/api/v1/admin/models", (route) =>
    route.fulfill({ json: state }),
  );
  await page.route("**/api/v1/admin/models/pull", async (route) => {
    if (route.request().method() === "DELETE") {
      state.pull.status = "cancelled";
      await route.fulfill({ json: {} });
    } else {
      state.pull = {
        id: `job-${++jobs}`,
        choice: route.request().postDataJSON().choice,
        status: "running",
      };
      await route.fulfill({ json: { id: state.pull.id } });
    }
  });
  try {
    await page.goto(f.adminUrl);
    await openStep(page, "stepTts");
    await expect(page.locator("#catalogModel option")).toHaveCount(1);
    await expect(page.locator("#sttCatalogModel option")).toHaveCount(1);
    await expect(page.locator("#sttCatalogModel")).toHaveValue(
      models[1].choice,
    );
    await expect(page.locator("#sttCatalogUse")).toHaveText(
      "続きからダウンロードして使う",
    );
    await page.locator("#runtimeModel").fill("/manual/tts.gguf");
    await page.locator("#sttCatalogUse").click();
    await expect(page.locator("#catalogUse")).toBeDisabled();
    await expect(page.locator("#catalogUse")).toHaveText(
      "別のモデルをダウンロード中です",
    );
    await expect(page.locator("#modelDirSave")).toBeDisabled();
    await expect(page.locator("#sttCatalogProgressText")).toContainText("25%");
    await page.reload();
    await openStep(page, "stepTts");
    await expect(page.locator("#sttCatalogCancel")).toBeVisible();
    await page.locator("#runtimeModel").fill("/manual/tts.gguf");
    models[1].fetched = true;
    state.pull = { ...state.pull, status: "done", path: models[1].path };
    await expect(page.locator("#sttModel")).toHaveValue(models[1].path);
    await expect(page.locator("#runtimeModel")).toHaveValue("/manual/tts.gguf");
    expect(f.runtime.settings.saved.stt.enabled).toBe(false);
    expect(f.runtime.settings.saved.stt.model).toBe("");
    await page.locator("#sttModel").fill("/manual/asr.gguf");
    await page.locator("#sttCatalogModel").selectOption(models[1].choice);
    await expect(page.locator("#sttModel")).toHaveValue("/manual/asr.gguf");
    await page.locator("#catalogUse").click();
    await expect(page.locator("#sttCatalogUse")).toBeDisabled();
    await expect(page.locator("#sttCatalogUse")).toHaveText(
      "別のモデルをダウンロード中です",
    );
    await page.locator("#catalogCancel").click();
    await expect(page.locator("#catalogStatus")).toContainText("中止しました");
    await page.locator("#sttCatalogUse").click();
    await expect(page.locator("#sttModel")).toHaveValue(models[1].path);
    await page.reload();
    await openStep(page, "stepTts");
    await expect(page.locator("#sttModel")).toHaveValue("");
    await expect(page.locator("#sttCatalogStatus")).toBeEmpty();
  } finally {
    await page.context().close();
    await f.close();
  }
});

for (const token of [false, true])
  test(`transcript download uses fresh count and server filename (${token ? "Bearer" : "Cookie"})`, async ({
    page,
  }) => {
    const f = await fixture();
    const files = chatterFiles((path) =>
      readFileSync(new URL(`../${path}`, import.meta.url)),
    );
    expect(files.get("panel.html").toString()).toContain(
      'id="downloadTranscripts"',
    );
    expect(files.get("shared/player.js").toString()).toContain(
      '"X-Transcript-Count"',
    );
    let count = 0,
      fail = false;
    const requests = [];
    await page.route("**/api/v1/rooms/*/transcripts", async (route) => {
      requests.push(route.request().headers());
      await route.fulfill(
        fail
          ? { status: 503, json: { error: "書き出し失敗" } }
          : {
              contentType: "application/zip",
              headers: {
                "Content-Disposition":
                  'attachment; filename="transcripts-20261028-120000.zip"',
                "X-Transcript-Count": String(count),
              },
              body: zipFiles(
                new Map([["transcript.txt", Buffer.from("test")]]),
              ),
            },
      );
    });
    try {
      const response = await fetch(`${f.base}/api/v1/admin/commands`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.app.store.secrets.admin}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ command: "invite", commandId: "stt-invite" }),
      });
      const invite = await response.json();
      await page.goto(
        invite.url.replace(":0/", `:${f.app.server.address().port}/`),
      );
      await expect(page.locator("#status")).toContainText("接続しました");
      await expect(page.locator("#transcriptDownloads")).toBeHidden();
      // Advertise zero records, then produce a record without another snapshot.
      f.app.engine.transcriptLog = { count: 0 };
      await page.reload();
      await expect(page.locator("#downloadTranscripts")).toBeVisible();
      if (token)
        await page.evaluate(async () => {
          const { bridge } = await import("/web/bridge-client.js");
          bridge.token = "test-chatter-token";
        });
      await page.locator("#downloadTranscripts").click();
      await expect(page.locator("#transcriptDownloadStatus")).toHaveText(
        "まだ文字起こしはありません",
      );
      count = 1;
      const downloaded = page.waitForEvent("download");
      await page.locator("#downloadTranscripts").click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe(
        "transcripts-20261028-120000.zip",
      );
      expect(
        readFileSync(await download.path())
          .subarray(0, 2)
          .toString(),
      ).toBe("PK");
      await expect(page.locator("#transcriptDownloadStatus")).toContainText(
        "ダウンロードしました",
      );
      fail = true;
      await page.locator("#downloadTranscripts").click();
      await expect(page.locator("#transcriptDownloadStatus")).toHaveText(
        "書き出し失敗",
      );
      await expect(page.locator("#downloadTranscripts")).toBeEnabled();
      if (token)
        expect(
          requests.every(
            (r) => r.authorization === "Bearer test-chatter-token",
          ),
        ).toBe(true);
      else
        expect(requests.every((r) => r.cookie?.includes("trpg_player="))).toBe(
          true,
        );
      await page.getByRole("button", { name: "退出", exact: true }).click();
      await expect(page.locator("#downloadTranscripts")).toBeDisabled();
    } finally {
      await page.context().close();
      await f.close();
    }
  });
