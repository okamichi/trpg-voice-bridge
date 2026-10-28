import * as fs from "node:fs";
import { join } from "node:path";
import { zipFiles } from "../chatter/zip.mjs";

export function transcriptStamp(now = new Date()) {
  const d = new Date(now),
    pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const reasons = {
  shutdown: "終了の期限切れ",
  backlog: "順番待ちの上限",
  unwritten: "書けない行の上限",
  error: "文字起こしの失敗",
};

// Only unwritten records are retained in memory. A committed byte offset lets
// retries remove a partial write rather than duplicating or corrupting JSONL.
export class TranscriptLog {
  constructor({
    dataDir,
    logDir = "",
    now = new Date(),
    io = fs,
    limit = 20000,
    onError = () => {},
  }) {
    Object.assign(this, { io, limit, onError });
    this.dir = logDir || join(dataDir, "transcripts");
    this.base = `transcript-${transcriptStamp(now)}`;
    this.path = "";
    this.pending = [];
    this.count = 0;
    this.chats = 0;
    this.offset = 0;
    this.error = "";
    this.unwritten = 0;
    this.flush();
  }
  snapshot() {
    return {
      enabled: true,
      count: this.count,
      chats: this.chats,
      path: this.path,
      error: this.error,
    };
  }
  add(entry) {
    this.count++;
    this.enqueue({ ...entry, time: new Date(entry.time).toISOString() });
  }
  // A chat line is stamped with the time Bridge accepted it, whatever its
  // source. Clearing the chat history later leaves the log as written.
  chat(message) {
    this.chats++;
    this.enqueue({
      type: "chat",
      time: new Date(message.createdAt).toISOString(),
      messageId: message.id,
      source: message.source,
      characterId: message.characterId ?? null,
      speakerName: message.speakerName,
      text: message.text,
    });
  }
  dropped(reason, count) {
    if (count > 0)
      this.enqueue({
        type: "dropped",
        time: new Date().toISOString(),
        reason,
        count,
      });
  }
  enqueue(entry) {
    this.pending.push(entry);
    while (this.pending.length > this.limit) {
      const old = this.pending.shift();
      this.unwritten += old.type === "dropped" ? old.count : 1;
    }
    this.flush();
  }
  missing() {
    return this.unwritten
      ? [
          {
            type: "dropped",
            time: new Date().toISOString(),
            reason: "unwritten",
            count: this.unwritten,
          },
        ]
      : [];
  }
  flush() {
    let fd;
    try {
      if (!this.path) {
        this.io.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        for (let n = 1; ; n++) {
          const path = join(
            this.dir,
            `${this.base}${n === 1 ? "" : `-${n}`}.jsonl`,
          );
          try {
            fd = this.io.openSync(path, "wx+", 0o600);
            this.path = path;
            break;
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
          }
        }
      } else fd = this.io.openSync(this.path, "r+");
      this.io.ftruncateSync(fd, this.offset);
      const rows = [...this.missing(), ...this.pending];
      if (rows.length) {
        const bytes = Buffer.from(
          rows.map((e) => JSON.stringify(e) + "\n").join(""),
        );
        let written = 0;
        while (written < bytes.length) {
          const n = this.io.writeSync(
            fd,
            bytes,
            written,
            bytes.length - written,
            this.offset + written,
          );
          if (!n) throw Error("write stalled");
          written += n;
        }
        this.offset += bytes.length;
      }
      this.pending = [];
      this.unwritten = 0;
      this.error = "";
    } catch {
      this.failed();
    } finally {
      if (fd !== undefined) {
        try {
          this.io.closeSync(fd);
        } catch {
          this.failed();
        }
      }
    }
  }
  failed() {
    if (!this.error) this.onError("文字起こしのファイルを書き出せません");
    this.error = "文字起こしのファイルを書き出せません";
  }
  zip() {
    // Ignore any uncommitted suffix from a failed write.
    const disk =
      this.path && this.offset
        ? this.io
            .readFileSync(this.path)
            .subarray(0, this.offset)
            .toString("utf8")
            .trimEnd()
            .split("\n")
            .map(JSON.parse)
        : [];
    const rows = [...disk, ...this.missing(), ...this.pending].sort(
      (a, b) => Date.parse(a.time) - Date.parse(b.time),
    );
    const lines = rows.map((e) => {
      const time = new Date(e.time).toLocaleTimeString("ja-JP", {
        hour12: false,
      });
      // Rows lost to an unwritable file may be chat lines, not just speech.
      if (e.type === "dropped")
        return `[${time}] ※ ${e.reason === "unwritten" ? "記録できなかった行" : "文字にできなかった発言"}: ${e.count}件（${reasons[e.reason] ?? e.reason}）`;
      return `[${time}] ${e.type === "chat" ? "[チャット] " : ""}${e.speakerName}: ${e.text}`.replace(
        /[\r\n]/g,
        " ",
      );
    });
    return zipFiles(
      new Map([
        ["transcript.txt", lines.length ? lines.join("\n") + "\n" : ""],
        [
          "transcript.jsonl",
          rows.map((e) => JSON.stringify(e) + "\n").join(""),
        ],
      ]),
    );
  }
}
