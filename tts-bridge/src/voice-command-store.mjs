import { check } from "./contracts.mjs";

const active = new Set(["queued", "generating", "designing", "registering"]);

// Command state is separate from editable character settings and their comparisons.
export class VoiceCommandStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS voice_commands (
        id TEXT PRIMARY KEY, characterId TEXT, active INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_voice_registration
        ON voice_commands(characterId) WHERE active=1;
      CREATE TABLE IF NOT EXISTS voice_states (characterId TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    this.store.transaction(() => {
      this.cancel(
        null,
        "再起動により登録が中断しました。もう一度登録してください。",
      );
    });
  }
  get(id) {
    const row = this.db
      .prepare("SELECT data FROM voice_commands WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.data) : null;
  }
  busy(characterId) {
    return !!this.db
      .prepare("SELECT id FROM voice_commands WHERE characterId=? AND active=1")
      .get(characterId);
  }
  assertIdle(characterId) {
    check(
      !this.busy(characterId),
      "声の登録中です。完了後にもう一度操作してください",
      409,
    );
  }
  all() {
    return this.db
      .prepare("SELECT data FROM voice_commands ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  states() {
    return Object.fromEntries(
      this.db
        .prepare("SELECT characterId, data FROM voice_states")
        .all()
        .map((r) => [r.characterId, JSON.parse(r.data)]),
    );
  }
  // These writes run inside the caller's synchronous transaction.
  write(job, display = true) {
    job.updated = Date.now();
    this.db
      .prepare(
        "INSERT INTO voice_commands VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET characterId=excluded.characterId, active=excluded.active, data=excluded.data",
      )
      .run(
        job.id,
        job.characterId ?? null,
        active.has(job.status) ? 1 : 0,
        JSON.stringify(job),
      );
    this.store.status(job.id, job.status);
    if (display && job.characterId) {
      const state = {
        operationId: job.id,
        kind: job.kind,
        status: job.status,
        reason: job.reason ?? "",
        note: job.note ?? "",
        unplayed: !!job.unplayed,
      };
      this.db
        .prepare("INSERT OR REPLACE INTO voice_states VALUES (?,?)")
        .run(job.characterId, JSON.stringify(state));
    }
  }
  clear(characterId) {
    this.db
      .prepare("DELETE FROM voice_states WHERE characterId=?")
      .run(characterId);
  }
  clearAll() {
    this.db.exec("DELETE FROM voice_states");
  }
  cancel(characterId, reason, display = true) {
    const jobs = this.db
      .prepare("SELECT data FROM voice_commands WHERE active=1")
      .all();
    for (const row of jobs) {
      const job = JSON.parse(row.data);
      if (characterId && job.characterId !== characterId) continue;
      this.write({ ...job, status: "failed", reason, note: "" }, display);
    }
  }
  update(id, changes) {
    let result;
    this.store.transaction(() => {
      const job = this.get(id);
      if (!job || !active.has(job.status)) return;
      result = { ...job, ...changes };
      if (!active.has(result.status)) result.note = "";
      this.write(result);
    });
    return result;
  }
  diagnostics() {
    return this.all()
      .slice(0, 30)
      .map(
        ({
          id,
          characterId,
          kind,
          status,
          reason,
          detail,
          referenceId,
          updated,
        }) => ({
          id,
          characterId,
          kind,
          status,
          reason,
          detail,
          referenceId,
          updated,
        }),
      );
  }
  prune() {
    this.db
      .prepare(
        "DELETE FROM voice_commands WHERE active=0 AND json_extract(data,'$.updated')<?",
      )
      .run(Date.now() - 86400000);
  }
}
