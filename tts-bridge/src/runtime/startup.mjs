import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { exposed } from "./settings.mjs";

// The admin page offers these. It always opens on 127.0.0.1, so other
// addresses stay available only through TTS_BRIDGE_HOST.
export const STARTUP_HOSTS = ["127.0.0.1", "0.0.0.0"];
const FIELDS = ["dataDir", "host", "port", "publicOrigin"];

const failure = (message, status) =>
  Object.assign(exposed(message), { status });

export const lockLabel = (name) =>
  name.startsWith("--") ? `起動オプション ${name}` : `環境変数 ${name}`;

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw exposed("Bridgeのポートは1～65535で指定してください");
}

function checkOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    /* Reported below. */
  }
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== value
  )
    throw exposed(
      "公開Originは http://アドレス:ポート の形で指定してください（パスと末尾の / は付けない）",
    );
}

export function validateStartup(value) {
  const { dataDir, host, port, publicOrigin } = value;
  if (
    typeof dataDir !== "string" ||
    dataDir.includes("\0") ||
    (dataDir && !isAbsolute(dataDir))
  )
    throw exposed("保存先は絶対パスで指定してください（空欄なら既定の保存先）");
  if (!STARTUP_HOSTS.includes(host))
    throw exposed("待ち受けアドレスは127.0.0.1か0.0.0.0を指定してください");
  checkPort(port);
  if (typeof publicOrigin !== "string") throw exposed("公開Originが不正です");
  if (publicOrigin) checkOrigin(publicOrigin);
  return { dataDir, host, port, publicOrigin };
}

// Launch options and environment variables fix a field for this process, and
// the admin page names the one that does. Options win over variables.
export function launchOverrides(env = process.env, options = {}) {
  const overrides = {},
    locks = {};
  const fix = (field, name, value, convert = (x) => x) => {
    if (value === undefined || field in overrides) return;
    overrides[field] = convert(value);
    locks[field] = name;
  };
  fix("dataDir", "--data-dir", options.dataDir, (x) => resolve(x));
  fix("port", "--port", options.port, Number);
  fix("dataDir", "TTS_DATA_DIR", env.TTS_DATA_DIR, (x) => resolve(x));
  fix("host", "TTS_BRIDGE_HOST", env.TTS_BRIDGE_HOST);
  fix("port", "TTS_BRIDGE_PORT", env.TTS_BRIDGE_PORT, Number);
  fix("publicOrigin", "TTS_PUBLIC_ORIGIN", env.TTS_PUBLIC_ORIGIN);
  // The admin origin names the port, so the port cannot move under it.
  if (env.TTS_LOCAL_ORIGIN !== undefined) locks.port ??= "TTS_LOCAL_ORIGIN";
  return { overrides, locks };
}

// The settings file lives outside the data directory it names.
export class StartupSettings {
  constructor({ file, defaults, overrides = {}, locks = {} }) {
    this.file = file;
    this.defaults = defaults;
    this.locks = locks;
    this.lastRestart = null;
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw exposed("起動設定が不正です");
      this.saved = validateStartup({ ...this.blank(), ...value });
    } catch (e) {
      if (e.code !== "ENOENT")
        throw exposed(
          `起動設定ファイルを読み込めません（${file}）。${e.expose ? `${e.message}。` : ""}削除すると既定値で起動します。`,
        );
      this.saved = null;
    }
    if (
      overrides.host !== undefined &&
      (typeof overrides.host !== "string" || !overrides.host)
    )
      throw exposed("待ち受けアドレスを指定してください");
    if (overrides.port !== undefined) checkPort(overrides.port);
    if (overrides.publicOrigin) checkOrigin(overrides.publicOrigin);
    this.overrides = { ...overrides };
    // A field locked without a value keeps the one this process started with.
    const started = this.effective(this.saved ?? this.blank());
    for (const field of Object.keys(locks))
      this.overrides[field] ??= started[field];
    this.active = this.effective(this.saved ?? this.blank());
  }
  blank() {
    const { host, port, publicOrigin } = this.defaults;
    return { dataDir: "", host, port, publicOrigin };
  }
  effective(saved) {
    const value = { ...saved, ...this.overrides };
    return { ...value, dataDir: value.dataDir || this.defaults.dataDir };
  }
  // The value to save (null removes the file, undefined keeps it) and the
  // effective settings for the next start.
  plan(kind, input) {
    if (kind === "reset")
      return { saved: null, active: this.effective(this.blank()) };
    if (kind === "restart")
      return {
        saved: undefined,
        active: this.effective(this.saved ?? this.blank()),
      };
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw exposed("起動設定が不正です");
    for (const field of Object.keys(input)) {
      if (!FIELDS.includes(field)) throw exposed("起動設定が不正です");
      if (this.locks[field])
        throw exposed(
          `${lockLabel(this.locks[field])}で指定中の項目は変更できません`,
        );
    }
    const saved = validateStartup({
      ...(this.saved ?? this.blank()),
      ...input,
    });
    return { saved, active: this.effective(saved) };
  }
  // Called once Bridge runs with the plan, so a failed start saves nothing.
  apply(plan) {
    this.active = plan.active;
    if (plan.saved === null) {
      rmSync(this.file, { force: true });
      this.saved = null;
    } else if (plan.saved) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        `${this.file}.tmp`,
        JSON.stringify(plan.saved, null, 2) + "\n",
        { mode: 0o600 },
      );
      renameSync(`${this.file}.tmp`, this.file);
      this.saved = plan.saved;
    }
  }
  snapshot() {
    return {
      file: this.file,
      defaults: this.defaults,
      saved: this.saved,
      active: this.active,
      locks: this.locks,
      lastRestart: this.lastRestart,
    };
  }
}

export async function probePort(port, host) {
  try {
    await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(port, host, () => probe.close(resolve));
    });
  } catch (e) {
    throw failure(
      e.code === "EADDRINUSE"
        ? `Bridgeのポート${port}は使用中です`
        : `${host}:${port}で待ち受けできません`,
      409,
    );
  }
}

export function checkDataDir(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
  } catch {
    throw failure(`保存先を作成できないか、書き込めません（${dir}）`, 409);
  }
}
