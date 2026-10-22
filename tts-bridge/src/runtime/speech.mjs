import { spawn } from "node:child_process";
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

// Windows' STATUS_DLL_NOT_FOUND. The Vulkan build cannot start without the
// Vulkan loader, vulkan-1.dll, which GPU drivers install.
const DLL_NOT_FOUND = 0xc0000135;

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
    speechProgram,
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
    this.status =
      this.settings.active.mode === "external" ? "external" : "stopped";
    this.error = "";
  }
  snapshot() {
    return {
      active: this.settings.active,
      saved: this.settings.saved,
      backends: this.settings.backends,
      status: this.status,
      error: this.error,
      restartRequired:
        JSON.stringify(this.settings.active) !==
        JSON.stringify(this.settings.saved),
    };
  }
  provider(saved) {
    return this.settings.active.mode === "bundled"
      ? {
          ...saved,
          type: "irodori",
          baseUrl: `http://127.0.0.1:${this.settings.active.ttsPort}`,
        }
      : saved;
  }
  fetch = (...args) => {
    if (this.settings.active.mode === "bundled" && this.status !== "ready")
      throw Error(this.error || "内蔵TTSは準備中です");
    return fetch(...args);
  };
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
      "--host",
      "127.0.0.1",
      "--port",
      String(ttsPort),
      // A chosen Vulkan build fails without a GPU instead of silently running
      // on the CPU, which cannot speak a line within seconds.
      ...(vulkan ? ["--device", "gpu"] : []),
      "--irodori-compatible",
      "--voices-dir",
      join(this.dataDir, "voices"),
    ];
  }
  async acquire() {
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
    this.status = "error";
    this.error = message;
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
          const response = await fetch(`http://127.0.0.1:${ttsPort}/health`, {
            signal: AbortSignal.timeout(1000),
          });
          await response.body?.cancel();
          if (
            response.ok &&
            this.childAlive &&
            !this.closing &&
            this.status === "starting"
          ) {
            this.status = "ready";
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
    open: async (active, prepared) =>
      (runtime = prepared ?? (await open(active.dataDir))),
  };
}
