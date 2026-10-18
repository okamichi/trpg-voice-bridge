import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// Marks a fixed message written for users. The launcher prints only these, so
// library errors that may carry secrets never reach the console.
export const exposed = (message) =>
  Object.assign(Error(message), { expose: true });

export function validateRuntime(value) {
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
  return { mode: value.mode, model: value.model, ttsPort: value.ttsPort };
}

export class RuntimeSettings {
  constructor(dataDir, overrides = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "runtime.json");
    try {
      this.saved = validateRuntime(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (e) {
      if (e.code !== "ENOENT")
        throw exposed(`runtime.jsonを確認してください（${this.path}）`);
      this.saved = { mode: "external", model: "", ttsPort: 18088 };
    }
    this.active = validateRuntime({ ...this.saved, ...overrides });
  }
  save(value) {
    const next = validateRuntime(value);
    writeFileSync(`${this.path}.tmp`, JSON.stringify(next, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(`${this.path}.tmp`, this.path);
    this.saved = next;
  }
}
