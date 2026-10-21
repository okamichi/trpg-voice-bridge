import { randomUUID } from "node:crypto";
import { check } from "./contracts.mjs";

const WEEK = 7 * 86400000;
const MESSAGE_LIMIT = 10000;
const CHANGE_LIMIT = 50000;
const RECEIPT_LIMIT = 100000;

// One Store serves one room. Chat ordering survives both session and process restarts.
export class ChatStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_meta (
        id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL,
        messageSeq INTEGER NOT NULL, updateSeq INTEGER NOT NULL, changeFloor INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO chat_meta VALUES (1,1,0,0,0);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, updated INTEGER NOT NULL,
        created INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_messages_created ON chat_messages(created);
      CREATE TABLE IF NOT EXISTS chat_changes (
        seq INTEGER PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_receipts (
        key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, messageId TEXT NOT NULL,
        sessionId TEXT NOT NULL, created INTEGER NOT NULL, result TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_receipts_created ON chat_receipts(created);
    `);
  }
  metadata() {
    const m = this.db.prepare("SELECT * FROM chat_meta WHERE id=1").get();
    return {
      generation: m.generation,
      messageSeq: m.messageSeq,
      updateSeq: m.updateSeq,
      changeFloor: m.changeFloor,
      enabled: this.store.config.publishTextToPlayers,
    };
  }
  get(id) {
    const row = this.db
      .prepare("SELECT data FROM chat_messages WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.data) : null;
  }
  lookup(key, fingerprint) {
    const row = this.db
      .prepare("SELECT * FROM chat_receipts WHERE key=?")
      .get(key);
    if (!row) return null;
    check(row.fingerprint === fingerprint, "同じ発言IDの内容が異なります", 409);
    return {
      ...JSON.parse(row.result),
      duplicate: true,
      deleted: !this.get(row.messageId),
    };
  }
  completeReceipt(key, result) {
    this.db
      .prepare("UPDATE chat_receipts SET result=? WHERE key=?")
      .run(JSON.stringify(result), key);
  }
  changeInside(type, fields) {
    const { updateSeq, generation } = this.db
      .prepare(
        "UPDATE chat_meta SET updateSeq=updateSeq+1 WHERE id=1 RETURNING updateSeq,generation",
      )
      .get();
    const change = { type, generation, updateSeq, ...fields };
    this.db
      .prepare("INSERT INTO chat_changes VALUES (?,?,?)")
      .run(updateSeq, Date.now(), JSON.stringify(change));
    return change;
  }
  accept(key, fingerprint, data) {
    return this.store.transaction(() => {
      const prior = this.lookup(key, fingerprint);
      if (prior) return prior;
      check(
        this.db.prepare("SELECT COUNT(*) AS n FROM chat_receipts").get().n <
          RECEIPT_LIMIT,
        "チャット受付台帳の上限です",
        429,
      );
      const { messageSeq } = this.db
        .prepare(
          "UPDATE chat_meta SET messageSeq=messageSeq+1 WHERE id=1 RETURNING messageSeq",
        )
        .get();
      const message = {
        ...data,
        roomId: this.store.config.roomId,
        id: randomUUID(),
        seq: messageSeq,
        createdAt: Date.now(),
        audioStatus: "pending",
        audioOrders: [],
      };
      const change = this.changeInside("chat.message.created", { message });
      message.updated = change.updateSeq;
      // The change carries the same revision as the durable message.
      this.db
        .prepare("UPDATE chat_changes SET data=? WHERE seq=?")
        .run(JSON.stringify(change), change.updateSeq);
      this.db
        .prepare("INSERT INTO chat_messages VALUES (?,?,?,?,?)")
        .run(
          message.id,
          message.seq,
          message.updated,
          message.createdAt,
          JSON.stringify(message),
        );
      const result = { messageId: message.id, messageSeq, http: 201 };
      this.db
        .prepare("INSERT INTO chat_receipts VALUES (?,?,?,?,?,?)")
        .run(
          key,
          fingerprint,
          message.id,
          data.sessionId,
          Date.now(),
          JSON.stringify(result),
        );
      return { ...result, change };
    });
  }
  update(id, fields) {
    return this.store.transaction(() => {
      const message = this.get(id);
      if (!message) return null; // Cleared messages must never reappear.
      Object.assign(message, fields);
      const change = this.changeInside("chat.message.updated", { message });
      message.updated = change.updateSeq;
      this.db
        .prepare("UPDATE chat_changes SET data=? WHERE seq=?")
        .run(JSON.stringify(change), change.updateSeq);
      this.db
        .prepare("UPDATE chat_messages SET updated=?,data=? WHERE id=?")
        .run(message.updated, JSON.stringify(message), id);
      return change;
    });
  }
  list({ before, after, limit = 100 } = {}) {
    check(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      "取得件数は1～100件です",
    );
    check(
      !(before !== undefined && after !== undefined),
      "取得方向は一つだけ指定してください",
    );
    for (const n of [before, after])
      check(
        n === undefined || (Number.isSafeInteger(n) && n >= 0),
        "発言番号が不正です",
      );
    const rows = this.db
      .prepare(
        `SELECT data FROM chat_messages WHERE seq ${after !== undefined ? ">" : "<"} ?
       ORDER BY seq ${after !== undefined ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(after ?? before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map((r) => JSON.parse(r.data));
    if (after === undefined) messages.reverse();
    return { ...this.metadata(), messages, hasMore };
  }
  changes({ since, generation, limit = 100 }) {
    check(Number.isSafeInteger(since) && since >= 0, "更新番号が不正です");
    check(
      Number.isSafeInteger(generation) && generation >= 1,
      "履歴世代が不正です",
    );
    check(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      "取得件数は1～100件です",
    );
    const meta = this.metadata();
    if (
      generation !== meta.generation ||
      since < meta.changeFloor ||
      since > meta.updateSeq
    )
      return { ...meta, resetRequired: true, changes: [] };
    const rows = this.db
      .prepare("SELECT data FROM chat_changes WHERE seq>? ORDER BY seq LIMIT ?")
      .all(since, limit + 1);
    const changes = rows.slice(0, limit).map((r) => JSON.parse(r.data));
    return {
      ...meta,
      changes,
      hasMore: rows.length > limit,
      nextSince: changes.at(-1)?.updateSeq ?? since,
    };
  }
  // May be used within Store.change to atomically change the sharing setting.
  advanceGenerationInside(clear = false) {
    if (clear) this.db.exec("DELETE FROM chat_messages");
    this.db.exec(`DELETE FROM chat_changes;
      UPDATE chat_meta SET generation=generation+1, changeFloor=updateSeq WHERE id=1`);
  }
  clear() {
    this.store.transaction(() => this.advanceGenerationInside(true));
    return this.metadata();
  }
  recover() {
    for (const row of this.db.prepare("SELECT id FROM chat_messages").all()) {
      const m = this.get(row.id);
      const unfinished = ["pending", "queued", "synthesizing"].includes(
        m.audioStatus,
      );
      if (unfinished || m.audioStatus === "ready" || m.audioOrders.length)
        this.update(m.id, {
          audioStatus:
            m.audioStatus === "ready"
              ? "expired"
              : unfinished
                ? "interrupted"
                : m.audioStatus,
          audioOrders: [],
          audioReason: "Bridgeの再起動で音声は利用できなくなりました",
        });
    }
  }
  prune(sessionId, now = Date.now()) {
    const changes = [];
    this.store.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM chat_messages WHERE created<?
        OR id IN (SELECT id FROM chat_messages ORDER BY seq DESC LIMIT -1 OFFSET ?)`,
        )
        .all(now - WEEK, MESSAGE_LIMIT);
      for (const { id } of rows) {
        this.db.prepare("DELETE FROM chat_messages WHERE id=?").run(id);
        changes.push(
          this.changeInside("chat.message.deleted", { messageId: id }),
        );
      }
      // Changes hold revisions only, never retain deleted message bodies.
      if (rows.length) {
        const deleted = new Set(rows.map((r) => r.id));
        for (const row of this.db
          .prepare("SELECT seq,data FROM chat_changes")
          .all()) {
          const c = JSON.parse(row.data);
          if (deleted.has(c.message?.id)) {
            delete c.message;
            c.type = "chat.message.deleted";
            c.messageId = JSON.parse(row.data).message.id;
            this.db
              .prepare("UPDATE chat_changes SET data=? WHERE seq=?")
              .run(JSON.stringify(c), row.seq);
          }
        }
      }
      const old = this.db
        .prepare(
          `SELECT MAX(seq) AS seq FROM chat_changes WHERE created<?
        OR seq IN (SELECT seq FROM chat_changes ORDER BY seq DESC LIMIT -1 OFFSET ?)`,
        )
        .get(now - WEEK, CHANGE_LIMIT).seq;
      if (old !== null) {
        this.db.prepare("DELETE FROM chat_changes WHERE seq<=?").run(old);
        this.db
          .prepare(
            "UPDATE chat_meta SET changeFloor=MAX(changeFloor,?) WHERE id=1",
          )
          .run(old);
      }
      this.db
        .prepare("DELETE FROM chat_receipts WHERE created<? AND sessionId<>?")
        .run(now - WEEK, sessionId);
    });
    return changes;
  }
}
