import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  check,
  configSchema,
  canonical,
  resolveCharacter,
} from "./contracts.mjs";
export class Store {
  constructor(dir, initial) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = dir;
    this.defaults = structuredClone(configSchema(initial));
    this.db = new DatabaseSync(join(dir, "bridge.sqlite"));
    chmodSync(join(dir, "bridge.sqlite"), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS voices (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, orderId TEXT NOT NULL, seq INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES ('seq',0);`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT 1 FROM settings WHERE key='config'").get())
        this.write(initial);
      if (!this.auth("secrets"))
        this.setAuth("secrets", {
          admin: randomBytes(32).toString("hex"),
          hmac: randomBytes(32).toString("hex"),
        });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.secrets = this.auth("secrets");
    this.config = configSchema(this.read());
    this.db.exec(
      "UPDATE events SET status='cancelled' WHERE status IN ('queued','synthesizing','ready')",
    );
    this.prune();
  }
  auth(key) {
    const row = this.db.prepare("SELECT data FROM auth WHERE key=?").get(key);
    return row ? JSON.parse(row.data) : null;
  }
  setAuth(key, value) {
    this.db
      .prepare("INSERT OR REPLACE INTO auth VALUES (?,?)")
      .run(key, JSON.stringify(value));
  }
  revokeCollectors() {
    this.db.exec("DELETE FROM auth WHERE key LIKE 'collector:%'");
  }
  read() {
    return {
      ...JSON.parse(
        this.db.prepare("SELECT data FROM settings WHERE key='config'").get()
          .data,
      ),
      characters: this.db
        .prepare("SELECT data FROM characters ORDER BY rowid")
        .all()
        .map((x) => JSON.parse(x.data)),
      voiceProfiles: this.db
        .prepare("SELECT data FROM voices ORDER BY rowid")
        .all()
        .map((x) => JSON.parse(x.data)),
    };
  }
  write(config) {
    const { characters, voiceProfiles, ...settings } = configSchema(config);
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES ('config',?)")
      .run(JSON.stringify(settings));
    for (const [table, items] of [
      ["characters", characters],
      ["voices", voiceProfiles],
    ]) {
      this.db.exec(`DELETE FROM ${table}`);
      const stmt = this.db.prepare(`INSERT INTO ${table} VALUES (?,?)`);
      for (const item of items) stmt.run(item.id, JSON.stringify(item));
    }
  }
  change(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const next = this.read();
      const result = fn(next);
      this.write(next);
      this.db.exec("COMMIT");
      this.config = next;
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  compare(current, before) {
    check(
      before !== undefined && canonical(current) === canonical(before),
      "他の人が変更しています。画面を開き直して確認してください",
      409,
    );
  }
  save(next, before) {
    this.change((current) => {
      this.compare(current, before);
      Object.assign(current, structuredClone(next));
    });
    return this.config;
  }
  resetDefaults(defaults = this.defaults) {
    const validated = configSchema(defaults);
    this.change((c) => {
      c.characters = structuredClone(validated.characters);
      c.voiceProfiles = structuredClone(validated.voiceProfiles);
    });
  }
  discover(event) {
    let found = resolveCharacter(this.config, event);
    if (found) return { character: found, created: false };
    // Without a stable speaker ID, do not merge people merely by their names.
    if (!event.speaker.id && !(event.speaker.tokenId && event.speaker.sceneId))
      return { character: null, created: false };
    let created = false;
    this.change((c) => {
      found = resolveCharacter(c, event);
      if (found) return;
      const { adapter, instanceId, contextId } = event.source;
      const binding = {
        adapter,
        instanceId,
        contextId,
        ...(event.speaker.tokenId && event.speaker.sceneId
          ? { tokenId: event.speaker.tokenId, sceneId: event.speaker.sceneId }
          : { speakerId: event.speaker.id }),
      };
      found = {
        id: randomUUID(),
        displayName: event.speaker.name,
        enabled: true,
        voiceProfileId: null,
        bindings: [binding],
      };
      c.characters.push(found);
      created = true;
    });
    return { character: found, created };
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
    roomId: "campaign-01",
    allowedChannels: ["main"],
    allowedKinds: ["dialogue"],
    publishTextToPlayers: true,
    provider: {
      type: "irodori",
      baseUrl: "http://127.0.0.1:8088",
      model: "irodori-tts",
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
      provider: "irodori-local",
      voiceId: p.voice,
      caption: p.caption,
      seed: p.seed,
      steps: p.steps,
      speed: p.speed,
    })),
  };
}
