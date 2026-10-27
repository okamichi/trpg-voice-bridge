import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  accessSync,
  constants,
  mkdirSync,
  statSync,
  appendFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { SpeechModels } from "./models.mjs";
import { RuntimeSettings, exposed } from "./settings.mjs";
import { ReferenceVoices } from "../reference-voices.mjs";

// Windows' STATUS_DLL_NOT_FOUND. The Vulkan build cannot start without the
// Vulkan loader, vulkan-1.dll, which GPU drivers install.
const DLL_NOT_FOUND = 0xc0000135;
const runFile = promisify(execFile);

// Keep the reservation until the consumer finishes the body, including streamed
// PCM. A zero-sized queue avoids pulling (and releasing) an unread response.
function trackedResponse(response, signal, release) {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let abort;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", abort);
    release();
  };
  const body = new ReadableStream(
    {
      start(controller) {
        void reader.closed.catch((error) => {
          if (!finished) controller.error(error);
          finish();
        });
        abort = () => {
          if (finished) return;
          controller.error(signal.reason);
          void reader.cancel(signal.reason).catch(() => {});
          finish();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (finished) return;
          if (done) {
            controller.close();
            finish();
          } else controller.enqueue(value);
        } catch (error) {
          if (!finished) controller.error(error);
          finish();
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  const result = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const key of ["url", "redirected", "type"])
    Object.defineProperty(result, key, { value: response[key] });
  return result;
}

export function stopMessage(code, backend) {
  if (backend === "vulkan" && code === DLL_NOT_FOUND)
    return "Vulkanが見つかりません。GPUドライバを入れるか、起動方式で「内蔵speech.cpp（CPU）」を選んでBridgeを再起動してください";
  if (backend === "vulkan")
    return "内蔵TTSが停止しました。設定を確認してBridgeを再起動してください。GPUを使えない場合は、起動方式で「内蔵speech.cpp（CPU）」を選んでください";
  return "内蔵TTSが停止しました。設定を確認してBridgeを再起動してください";
}

export class SpeechRuntime {
  constructor({
    dataDir,
    runtimeDir,
    overrides,
    backends,
    startupTimeout = 180000,
    transcriptionTimeout = 120000,
    speechProgram,
    fetchImpl = fetch,
  }) {
    this.dataDir = dataDir;
    this.settings = new RuntimeSettings(dataDir, overrides, backends);
    this.runtimeDir = runtimeDir;
    const suffix = process.platform === "win32" ? ".exe" : "";
    this.models = new SpeechModels({
      dataDir,
      speech: speechProgram ?? [join(runtimeDir, `speech${suffix}`)],
      supervisor: join(runtimeDir, `bridge-supervisor${suffix}`),
    });
    this.startupTimeout = startupTimeout;
    this.transcriptionTimeout = transcriptionTimeout;
    this.status =
      this.settings.active.mode === "external" ? "external" : "stopped";
    this.error = "";
    this.fetchImpl = fetchImpl;
    this.references = new ReferenceVoices(fetchImpl, dataDir);
    this.shutdown = new AbortController();
    this.stt = {
      enabled: this.settings.active.stt.enabled,
      status: this.settings.active.stt.enabled ? "starting" : "off",
      error: "",
    };
    this.sttListeners = new Set();
    this.activityListeners = new Set();
    this.ttsActive = 0;
    this.sttActive = false;
  }
  snapshot() {
    return {
      active: this.settings.active,
      saved: this.settings.saved,
      backends: this.settings.backends,
      status: this.status,
      error: this.error,
      stt: { ...this.stt },
      referenceProgress:
        this.settings.active.mode === "bundled"
          ? this.references.progress(this.provider({}))
          : null,
      restartRequired:
        JSON.stringify(this.settings.active) !==
        JSON.stringify(this.settings.saved),
    };
  }
  provider(saved) {
    return this.settings.active.mode === "bundled"
      ? {
          ...saved,
          type: "speech",
          baseUrl: `http://127.0.0.1:${this.settings.active.ttsPort}`,
        }
      : saved;
  }
  fetch = (input, init) => {
    if (this.settings.active.mode === "bundled" && this.status !== "ready")
      throw Error(this.error || "内蔵TTSは準備中です");
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      this.stt.enabled &&
      method.toUpperCase() === "POST" &&
      new URL(input instanceof Request ? input.url : input).pathname ===
        "/v1/audio/speech"
    )
      return this.fetchSpeech(input, init);
    return this.fetchImpl(input, init);
  };
  onSttChange(listener) {
    this.sttListeners.add(listener);
    return () => this.sttListeners.delete(listener);
  }
  setStt(status, error = "") {
    if (this.stt.status === status && this.stt.error === error) return;
    this.stt = { ...this.stt, status, error };
    if (status === "error") this.log("stt error");
    for (const listener of this.sttListeners) {
      try {
        listener({ ...this.stt });
      } catch {
        // Extension failures must not turn a healthy TTS server into an error.
        this.log("stt listener error");
      }
    }
  }
  activityChanged() {
    for (const listener of [...this.activityListeners]) listener();
  }
  waitForActivity(signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.activityListeners.delete(finish);
        signal.removeEventListener("abort", finish);
        if (signal.aborted) reject(signal.reason);
        else resolve();
      };
      this.activityListeners.add(finish);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
  async fetchSpeech(input, init) {
    const callerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(callerSignal ? [callerSignal] : []),
    ]);
    signal.throwIfAborted();
    // Count CPU requests waiting for STT too: the next STT must yield to them.
    this.ttsActive++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.ttsActive--;
      this.activityChanged();
    };
    try {
      while (this.settings.active.backend === "cpu" && this.sttActive)
        await this.waitForActivity(signal);
      signal.throwIfAborted();
      const response = await this.fetchImpl(input, { ...init, signal });
      return trackedResponse(response, signal, release);
    } catch (error) {
      release();
      throw error;
    }
  }
  async transcribe(wav, { signal: callerSignal } = {}) {
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(callerSignal ? [callerSignal] : []),
    ]);
    signal.throwIfAborted();
    const ready = () => {
      if (this.stt.status !== "ready" || !this.recognition)
        throw Error(this.stt.error || "音声認識は準備できていません");
    };
    ready();
    while (this.ttsActive || this.sttActive) await this.waitForActivity(signal);
    signal.throwIfAborted();
    ready();
    this.sttActive = true;
    try {
      const form = new FormData();
      form.append(
        "file",
        new Blob([wav], { type: "audio/wav" }),
        "utterance.wav",
      );
      form.append("model", this.recognition.id);
      form.append("response_format", "json");
      if (
        this.recognition.speech.options?.some(
          (option) => option.name === "language",
        )
      )
        form.append("language", "ja");
      // The priority wait above is unbounded. Only the HTTP request and body
      // have a deadline, so a stalled recognizer cannot keep CPU TTS waiting.
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.transcriptionTimeout),
      ]);
      const response = await this.fetchImpl(
        `${this.provider({}).baseUrl}/v1/audio/transcriptions`,
        { method: "POST", body: form, signal: requestSignal },
      );
      if (!response.ok) {
        let message = "";
        try {
          message = String((await response.json()).error?.message ?? "")
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .slice(0, 300);
        } catch {
          requestSignal.throwIfAborted();
        }
        throw Error(
          `音声認識 HTTP ${response.status}${message ? `: ${message}` : ""}`,
        );
      }
      const { text } = await response.json();
      return typeof text === "string" ? text.trim() : "";
    } finally {
      this.sttActive = false;
      this.activityChanged();
    }
  }
  async preflightStt() {
    this.sttModel = undefined;
    if (!this.stt.enabled) return;
    const { model } = this.settings.active.stt;
    try {
      if (!statSync(model).isFile()) throw Error();
      accessSync(model, constants.R_OK);
    } catch {
      this.setStt("error", "STTモデルが見つからないか読み取れません");
      return;
    }
    try {
      const [program, ...args] = this.models.speech;
      const { stdout } = await runFile(
        program,
        [...args, "info", model, "--json"],
        {
          windowsHide: true,
          timeout: 10000,
          maxBuffer: 1024 * 1024,
          signal: this.shutdown.signal,
        },
      );
      if (JSON.parse(stdout).task !== "recognition") {
        this.setStt(
          "error",
          "指定したファイルは音声認識のモデルではありません",
        );
        return;
      }
      this.sttModel = model;
    } catch {
      if (!this.closing)
        this.setStt(
          "error",
          "STTモデルを確認できません。ファイルと同梱のspeechを確認してください",
        );
    }
  }
  async loadRecognition(signal) {
    if (!this.sttModel) return;
    try {
      const response = await this.fetchImpl(
        `${this.provider({}).baseUrl}/v1/models`,
        { signal },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw Error();
      }
      const { data } = await response.json();
      this.recognition = Array.isArray(data)
        ? data.find(
            (model) =>
              model?.speech?.task === "recognition" &&
              typeof model.id === "string",
          )
        : undefined;
      if (!this.recognition) throw Error();
    } catch {
      if (!this.closing && this.stt.status === "starting")
        this.setStt(
          "error",
          "speech serveに音声認識モデルがありません。STTモデルを確認してください",
        );
    }
  }
  log(event) {
    // Only our fixed lifecycle messages are stored. Never persist upstream
    // stdout/stderr: speech's startup output includes an admin access URL.
    const dir = join(this.dataDir, "logs");
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "speech.log");
      if (existsSync(path) && statSync(path).size > 1024 * 1024)
        renameSync(path, `${path}.old`);
      appendFileSync(path, `${new Date().toISOString()} ${event}\n`, {
        mode: 0o600,
      });
    } catch {
      /* A full disk must not break child cleanup. */
    }
  }
  // The supervisor's arguments after the lock file, for the bundled mode.
  speechCommand() {
    const suffix = process.platform === "win32" ? ".exe" : "";
    const { model, ttsPort, backend } = this.settings.active;
    const vulkan = backend === "vulkan";
    return [
      "--listen-port",
      String(ttsPort),
      join(this.runtimeDir, `${vulkan ? "speech-vulkan" : "speech"}${suffix}`),
      "serve",
      model,
      ...(this.sttModel ? [this.sttModel] : []),
      "--host",
      "127.0.0.1",
      "--port",
      String(ttsPort),
      // A chosen Vulkan build fails without a GPU instead of silently running
      // on the CPU, which cannot speak a line within seconds.
      ...(vulkan ? ["--device", "gpu"] : []),
    ];
  }
  async acquire() {
    await this.preflightStt();
    if (this.closing) return;
    const suffix = process.platform === "win32" ? ".exe" : "";
    const args = [join(this.dataDir, "bridge.lock")];
    if (this.settings.active.mode === "bundled")
      args.push(...this.speechCommand());
    this.helper = spawn(
      join(this.runtimeDir, `bridge-supervisor${suffix}`),
      args,
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.helper.stdin.on("error", () => {});
    this.closed = new Promise((resolve) => this.helper.once("close", resolve));
    let locked = false;
    const lockedPromise = new Promise((resolve, reject) => {
      this.helper.once("error", () =>
        reject(
          exposed(
            "同梱の起動管理プログラムを開始できません。展開したフォルダのruntime/speechを確認してください。",
          ),
        ),
      );
      this.helper.once("exit", () => {
        if (!locked)
          reject(
            exposed(
              `同じ保存先のBridgeがすでに起動しているか、保存先にアクセスできません（保存先: ${this.dataDir}）。起動中のBridgeを終了するか、--data-dir で別の保存先を指定してください。`,
            ),
          );
        else if (!this.closing) {
          this.fail("起動管理プログラムが停止しました");
          this.onFatal?.();
        }
      });
      createInterface({ input: this.helper.stdout }).on("line", (line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.event === "locked") {
          locked = true;
          resolve();
        }
        if (event.event === "listening") this.listening = true;
        if (event.event === "spawned") {
          this.childAlive = true;
          this.log("spawned");
        }
        if (["exited", "spawn-error"].includes(event.event)) {
          this.childAlive = false;
          if (!this.closing && this.status !== "error")
            this.fail(stopMessage(event.code, this.settings.active.backend));
        }
      });
    });
    // Readiness comes from OS socket ownership, never localized/colorized text.
    // Drain and discard upstream output, including its private admin URL.
    this.helper.stderr.resume();
    try {
      await lockedPromise;
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  fail(message) {
    if (this.sttModel && this.status === "starting")
      message += "。STTを無効にして再起動してください";
    this.status = "error";
    this.error = message;
    if (this.stt.enabled) this.setStt("error", message);
    this.shutdown.abort(Error(message));
    this.log("error");
  }
  async start() {
    if (this.settings.active.mode !== "bundled" || this.closing) return;
    const { model, ttsPort } = this.settings.active;
    try {
      if (!model || !statSync(model).isFile()) throw Error();
      accessSync(model, constants.R_OK);
    } catch {
      this.fail(
        "GGUFモデルが見つからないか読み取れません。設定後に再起動してください",
      );
      return;
    }
    try {
      await new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(ttsPort, "127.0.0.1", () => probe.close(resolve));
      });
    } catch {
      this.fail(
        "内蔵TTSのポートが使用中です。ポートを変更して再起動してください",
      );
      return;
    }
    if (this.closing) return;
    mkdirSync(join(this.dataDir, "voices"), { recursive: true });
    this.status = "starting";
    this.log("starting");
    this.helper.stdin.write("S");
    const deadline = Date.now() + this.startupTimeout;
    while (
      !this.closing &&
      this.status === "starting" &&
      Date.now() < deadline
    ) {
      if (this.listening && this.childAlive) {
        try {
          const response = await this.fetchImpl(
            `http://127.0.0.1:${ttsPort}/health`,
            {
              signal: AbortSignal.timeout(1000),
            },
          );
          await response.body?.cancel();
          if (
            response.ok &&
            this.childAlive &&
            !this.closing &&
            this.status === "starting"
          ) {
            try {
              await this.references.prepare(
                this.provider({}),
                AbortSignal.timeout(Math.max(1, deadline - Date.now())),
              );
            } catch (e) {
              if (!this.closing) {
                this.fail(`参照音声の復元に失敗しました: ${e.message}`);
                this.helper.stdin.write("T");
              }
              return;
            }
            if (this.closing || !this.childAlive || this.status !== "starting")
              return;
            await this.loadRecognition(
              AbortSignal.any([
                this.shutdown.signal,
                AbortSignal.timeout(
                  Math.max(1, Math.min(5000, deadline - Date.now())),
                ),
              ]),
            );
            if (this.closing || !this.childAlive || this.status !== "starting")
              return;
            this.status = "ready";
            if (this.recognition && this.stt.status === "starting")
              this.setStt("ready");
            this.log("ready");
            return;
          }
        } catch {
          /* Loading or startup failure; bounded by deadline. */
        }
      }
      await delay(100);
    }
    if (!this.closing && this.status === "starting") {
      this.fail(
        "内蔵TTSの起動がタイムアウトしました。モデルとログを確認して再起動してください",
      );
      this.helper.stdin.write("T");
    }
  }
  async close() {
    this.closing = true;
    this.shutdown.abort(new DOMException("Bridgeは終了中です", "AbortError"));
    if (this.stt.enabled) this.setStt("off");
    await this.references.close();
    await this.models.close();
    if (!this.helper) return;
    this.helper.stdin.end("Q");
    await this.closed;
    this.status = "stopped";
  }
}

// Start hooks for Bridge with the bundled TTS. Each data directory has its own
// runtime and lock; a new directory's lock is taken while Bridge still runs.
export function speechLifecycle(options) {
  let runtime;
  const open = async (dataDir) => {
    const created = new SpeechRuntime({ ...options, dataDir });
    await created.acquire();
    return created;
  };
  return {
    get runtime() {
      return runtime;
    },
    prepare: async (next, previous) => {
      if (runtime?.models.downloading)
        throw Object.assign(
          exposed(
            "モデルのダウンロード中は再起動できません。ダウンロードを中止してから再起動してください",
          ),
          { status: 409 },
        );
      // The new directory may belong to another Bridge or hold a broken
      // runtime.json; both conflict with the request rather than reject it.
      if (next.dataDir !== previous.dataDir)
        return open(next.dataDir).catch((e) => {
          throw Object.assign(e, { status: e.status ?? 409 });
        });
    },
    // Until options reach the launcher, this hook owns cleanup on failure.
    boot: async (active, prepared, options) => {
      const created = (runtime = prepared ?? (await open(active.dataDir)));
      try {
        return {
          ...(await options(created)),
          runtime: created,
          onClose: () => created.close(),
        };
      } catch (error) {
        await created.close();
        throw error;
      }
    },
  };
}
