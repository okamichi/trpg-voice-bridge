import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// Marks a fixed message written for users. The launcher prints only these, so
// library errors that may carry secrets never reach the console.
export const exposed = (message) =>
  Object.assign(Error(message), { expose: true });

// The builds of speech.cpp a package carries, the default first: Windows has
// a Vulkan build for GPUs and a CPU build, macOS one Metal build.
export const platformBackends = (platform = process.platform) =>
  platform === "win32" ? ["vulkan", "cpu"] : ["metal"];

export function validateRuntime(value, backends = platformBackends()) {
  if (!value || !["external", "bundled"].includes(value.mode))
    throw exposed("TTSモードが不正です");
  if (
    typeof value.model !== "string" ||
    (value.model && (!isAbsolute(value.model) || !/\.gguf$/i.test(value.model)))
  )
    throw exposed("モデルはGGUFファイルの絶対パスを指定してください");
  if (
    !Number.isInteger(value.ttsPort) ||
    value.ttsPort < 1 ||
    value.ttsPort > 65535
  )
    throw exposed("TTSポートは1～65535で指定してください");
  const backend = value.backend ?? backends[0];
  if (!backends.includes(backend))
    throw exposed(`内蔵TTSの種類は${backends.join("、")}から指定してください`);
  const stt =
    value.stt === undefined
      ? { enabled: false, model: "", logDir: "" }
      : value.stt;
  if (!stt || typeof stt !== "object" || typeof stt.enabled !== "boolean")
    throw exposed("STTの設定が不正です");
  if (
    typeof stt.model !== "string" ||
    stt.model.includes("\0") ||
    (stt.model && (!isAbsolute(stt.model) || !/\.gguf$/i.test(stt.model)))
  )
    throw exposed("STTモデルはGGUFファイルの絶対パスを指定してください");
  if (
    typeof stt.logDir !== "string" ||
    stt.logDir.includes("\0") ||
    (stt.logDir && !isAbsolute(stt.logDir))
  )
    throw exposed("文字起こしの書き出し先は絶対パスを指定してください");
  if (stt.enabled && !stt.model) throw exposed("STTモデルを指定してください");
  if (stt.enabled && value.mode !== "bundled")
    throw exposed("STTは内蔵speech.cppのときだけ有効にできます");
  return {
    mode: value.mode,
    model: value.model,
    ttsPort: value.ttsPort,
    backend,
    stt: { enabled: stt.enabled, model: stt.model, logDir: stt.logDir },
  };
}

export class RuntimeSettings {
  constructor(dataDir, overrides = {}, backends = platformBackends()) {
    mkdirSync(dataDir, { recursive: true });
    this.backends = backends;
    this.path = join(dataDir, "runtime.json");
    try {
      this.saved = validateRuntime(
        JSON.parse(readFileSync(this.path, "utf8")),
        backends,
      );
    } catch (e) {
      if (e.code !== "ENOENT")
        throw exposed(`runtime.jsonを確認してください（${this.path}）`);
      this.saved = validateRuntime(
        { mode: "external", model: "", ttsPort: 18088 },
        backends,
      );
    }
    this.active = validateRuntime({ ...this.saved, ...overrides }, backends);
  }
  save(value) {
    const next = validateRuntime(value, this.backends);
    writeFileSync(`${this.path}.tmp`, JSON.stringify(next, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(`${this.path}.tmp`, this.path);
    this.saved = next;
  }
}
