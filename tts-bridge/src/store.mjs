import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { check, configSchema, canonical } from "./contracts.mjs";
export class Store {
  constructor(dir, initial) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = dir;
    this.path = join(dir, "config.json");
    const secretPath = join(dir, "credentials.json");
    if (!existsSync(secretPath))
      writeFileSync(
        secretPath,
        JSON.stringify({
          admin: randomBytes(32).toString("hex"),
          collector: randomBytes(32).toString("hex"),
          hmac: randomBytes(32).toString("hex"),
        }),
        { mode: 0o600 },
      );
    this.secrets = JSON.parse(readFileSync(secretPath));
    if (!existsSync(this.path)) this.atomic(initial);
    this.config = configSchema(JSON.parse(readFileSync(this.path)));
    this.db = new DatabaseSync(join(dir, "ledger.sqlite"));
    this.db.exec(
      `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, orderId TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL); INSERT OR IGNORE INTO meta VALUES ('seq',0);`,
    );
    this.db.exec(
      "UPDATE events SET status='cancelled' WHERE status IN ('queued','synthesizing','ready')",
    );
    this.prune();
  }
  atomic(c) {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
  save(next, revision) {
    check(
      revision === this.config.revision,
      "設定が更新されています。再読込してから保存してください",
      409,
    );
    check(Array.isArray(next?.voiceProfiles), "声の一覧が必要です");
    next = structuredClone(next);
    next.revision = revision + 1;
    for (const v of next.voiceProfiles) {
      const prev = this.config.voiceProfiles.find((x) => x.id === v.id);
      if (prev)
        v.revision =
          canonical({ ...prev, revision: 0 }) ===
          canonical({ ...v, revision: 0 })
            ? prev.revision
            : prev.revision + 1;
    }
    configSchema(next);
    copyFileSync(this.path, join(this.dir, `config.backup-${revision}.json`));
    this.atomic(next);
    this.config = next;
    const backups = readdirSync(this.dir)
      .filter((x) => /^config.backup-\d+.json$/.test(x))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    for (const f of backups.slice(10)) unlinkSync(join(this.dir, f));
    return next;
  }
  lookup(key) {
    return this.db.prepare("SELECT * FROM events WHERE key=?").get(key);
  }
  record(key, fingerprint, orderId, status) {
    check(
      this.db.prepare("SELECT COUNT(*) AS count FROM events").get().count <
        100000,
      "重複排除台帳の上限です",
      429,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const seq = this.db
        .prepare(
          "UPDATE meta SET value=value+1 WHERE key='seq' RETURNING value",
        )
        .get().value;
      this.db
        .prepare("INSERT INTO events VALUES (?,?,?,?,?,?)")
        .run(key, fingerprint, orderId, seq, status, Date.now());
      this.db.exec("COMMIT");
      return seq;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  status(orderId, status) {
    this.db
      .prepare("UPDATE events SET status=? WHERE orderId=?")
      .run(status, orderId);
  }
  maxSeq() {
    return this.db.prepare("SELECT value FROM meta WHERE key='seq'").get()
      .value;
  }
  prune() {
    this.db
      .prepare("DELETE FROM events WHERE created<?")
      .run(Date.now() - 86400000);
  }
  close() {
    this.db.close();
  }
}
export function initialConfig(profiles) {
  return {
    configVersion: 1,
    revision: 1,
    roomId: "campaign-01",
    allowedChannels: ["main"],
    allowedKinds: ["dialogue"],
    publishTextToPlayers: false,
    provider: {
      type: "irodori",
      baseUrl: "http://127.0.0.1:8088",
      model: "irodori-tts",
      runtimeRevision: "local-mlx-v1",
    },
    sources: [],
    characters: Object.entries(profiles).map(([id, p]) => ({
      id,
      displayName: p.name,
      enabled: true,
      voiceProfileId: id,
      bindings: [],
    })),
    voiceProfiles: Object.entries(profiles).map(([id, p]) => ({
      id,
      name: p.name,
      revision: 1,
      referenceRevision: 1,
      provider: "irodori-local",
      voiceId: p.voice,
      caption: p.caption,
      seed: p.seed,
      steps: p.steps,
      speed: p.speed,
    })),
  };
}
