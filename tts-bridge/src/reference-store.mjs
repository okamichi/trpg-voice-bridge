import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  lstatSync,
  unlinkSync,
  linkSync,
} from "node:fs";
import { join } from "node:path";
import { check } from "./contracts.mjs";
import { inspectWav, AUDIO_LIMIT } from "./provider.mjs";

export const referenceId = (id) =>
  typeof id === "string" &&
  /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
  !["none", "no_ref", "no-ref", "null", "text-only"].includes(id.toLowerCase());
const digest = (wav) => createHash("sha256").update(wav).digest("hex");
const put = (object, key, value) =>
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
export const referenceTarget = (p) => `${p.type}:${new URL(p.baseUrl).origin}`;

// This is the durable source of voices, never the expiring playback cache.
// Read the manifest on each operation: runtime restoration and Engine share it.
export class ReferenceStore {
  constructor(dataDir) {
    this.dir = join(dataDir, "voices");
    this.path = join(dataDir, "reference-voices.json");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  read() {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      check(
        value?.version === 1 &&
          value.voices &&
          typeof value.voices === "object" &&
          !Array.isArray(value.voices),
        "参照音声の保存台帳が不正です",
        500,
      );
      for (const [id, item] of Object.entries(value.voices))
        check(
          referenceId(id) &&
            item &&
            /^[a-f0-9]{64}$/.test(item.sha256) &&
            item.targets &&
            typeof item.targets === "object" &&
            !Array.isArray(item.targets),
          "参照音声の保存台帳が不正です",
          500,
        );
      return value;
    } catch (e) {
      if (e.code === "ENOENT") return { version: 1, voices: {} };
      throw e;
    }
  }
  write(value) {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(tmp, this.path);
    } finally {
      try {
        unlinkSync(tmp);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
  wav(id, expected) {
    check(referenceId(id), "参照音声IDが不正です");
    const path = join(this.dir, `${id}.wav`);
    let st;
    try {
      st = lstatSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      check(
        false,
        `参照音声「${id}」の元WAVがありません。元のWAVを戻すか、管理画面で管理対象から外して登録し直してください`,
        409,
      );
    }
    check(
      st.isFile() && st.size <= AUDIO_LIMIT,
      "参照音声は通常のWAVファイルを指定してください",
      500,
    );
    const wav = readFileSync(path);
    inspectWav(wav);
    check(
      !expected || digest(wav) === expected,
      `参照音声「${id}」のファイルが変更されています。別のIDで登録してください`,
      409,
    );
    return wav;
  }
  scan() {
    const data = this.read();
    const issues = [];
    let changed = false;
    // Adopt the old fork's voices directory without moving or deleting its WAVs.
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".wav")) continue;
      const id = file.slice(0, -4);
      if (!referenceId(id) || Object.hasOwn(data.voices, id)) continue;
      try {
        put(data.voices, id, { sha256: digest(this.wav(id)), targets: {} });
        changed = true;
      } catch (error) {
        issues.push({
          id,
          kind: "file",
          message: `参照音声「${id}」を読み込めません: ${error.message}`,
        });
      }
    }
    if (changed) this.write(data);
    const entries = Object.create(null);
    for (const [id, entry] of Object.entries(data.voices)) {
      try {
        const stat = lstatSync(join(this.dir, `${id}.wav`));
        check(
          stat.isFile() && stat.size <= AUDIO_LIMIT,
          "通常のWAVファイルが必要です",
          500,
        );
        entries[id] = entry;
      } catch (error) {
        issues.push({
          id,
          sha256: entry.sha256,
          kind: error.code === "ENOENT" ? "missing" : "file",
          message:
            error.code === "ENOENT"
              ? `参照音声「${id}」のWAVがありません。登録済みの接続先では使えますが、再登録には元のWAVが必要です。不要な記録は管理対象から外してください`
              : `参照音声「${id}」を読み込めません: ${error.message}`,
        });
      }
    }
    return { entries, issues, records: data.voices };
  }
  entries() {
    return this.scan().entries;
  }
  save(id, wav) {
    check(referenceId(id), "参照音声IDが不正です");
    inspectWav(wav);
    const data = this.read(),
      sha256 = digest(wav);
    const existing = Object.hasOwn(data.voices, id) ? data.voices[id] : null;
    // A missing backup needs an explicit detach, even for a different WAV:
    // old bindings on other servers must not be inherited by new audio.
    if (existing) this.wav(id, existing.sha256);
    check(
      !existing || existing.sha256 === sha256,
      "同じIDの参照音声が保存済みです。別のIDにしてください",
      409,
    );
    if (existing) {
      return;
    }
    const path = join(this.dir, `${id}.wav`);
    // Exclusive create also protects WAVs which have not yet been imported.
    const tmp = join(this.dir, `${randomUUID()}.tmp`);
    let createdFile = false;
    try {
      writeFileSync(tmp, wav, { mode: 0o600, flag: "wx" });
      linkSync(tmp, path);
      createdFile = true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      check(
        digest(this.wav(id)) === sha256,
        "同じIDの参照音声が保存済みです。別のIDにしてください",
        409,
      );
    } finally {
      try {
        unlinkSync(tmp);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    put(data.voices, id, { sha256, targets: {} });
    this.write(data);
    return createdFile ? { id, sha256 } : undefined;
  }
  rollback(receipt) {
    if (!receipt) return;
    const { id, sha256 } = receipt,
      data = this.read();
    const entry = Object.hasOwn(data.voices, id) && data.voices[id];
    check(
      entry && entry.sha256 === sha256 && !Object.keys(entry.targets).length,
      "保存状態が変わったため登録失敗後の取り消しができません。管理画面で確認してください",
      409,
    );
    this.wav(id, sha256);
    unlinkSync(join(this.dir, `${id}.wav`));
    delete data.voices[id];
    this.write(data);
  }
  forget(id, sha256) {
    check(referenceId(id), "参照音声IDが不正です");
    const data = this.read(),
      entry = Object.hasOwn(data.voices, id) && data.voices[id];
    check(
      entry && entry.sha256 === sha256,
      "保存音声が変更されています。再確認してください",
      409,
    );
    const path = join(this.dir, `${id}.wav`);
    let archived;
    try {
      const stat = lstatSync(path);
      check(
        stat.isFile(),
        "通常のWAVファイル以外は手動で移動してから再試行してください",
        409,
      );
      const dir = join(this.dir, "../voices-detached");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const destination = join(dir, `${id}-${randomUUID()}.wav`);
      renameSync(path, destination);
      archived = destination;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    delete data.voices[id];
    try {
      this.write(data);
    } catch (error) {
      if (archived) renameSync(archived, path);
      throw error;
    }
  }
  bound(id, provider) {
    const data = this.read();
    return (
      Object.hasOwn(data.voices, id) &&
      data.voices[id].targets[referenceTarget(provider)] === "registered"
    );
  }
  bind(id, provider) {
    const data = this.read();
    data.voices[id].targets[referenceTarget(provider)] = "registered";
    this.write(data);
  }
}
