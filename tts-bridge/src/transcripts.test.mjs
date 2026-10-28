import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptLog } from "./transcripts.mjs";

function setup(t, options = {}) {
  const dataDir = fs.mkdtempSync(join(tmpdir(), "transcripts-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return new TranscriptLog({ dataDir, ...options });
}
function unzip(bytes) {
  const files = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18),
      nameSize = bytes.readUInt16LE(offset + 26),
      extra = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameSize + extra;
    files.set(
      bytes.toString("utf8", offset + 30, offset + 30 + nameSize),
      bytes.toString("utf8", start, start + size),
    );
    offset = start + size;
  }
  return files;
}
const entry = (n) => ({
  time: 1700000000000 + n,
  speakerId: "123",
  speakerName: "参加者",
  seconds: 1,
  text: `発言${n}`,
});
test("transcripts: unique private files, sorted ZIP and all 20001 records", (t) => {
  const log = setup(t, { now: new Date(2026, 9, 28, 12, 0, 0) });
  const other = new TranscriptLog({
    dataDir: log.dir,
    logDir: log.dir,
    now: new Date(2026, 9, 28, 12, 0, 0),
  });
  assert.notEqual(log.path, other.path);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(log.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(log.dir).mode & 0o777, 0o700);
  }
  for (let n = 20000; n >= 0; n--) log.add(entry(n));
  assert.equal(log.pending.length, 0);
  assert.equal(log.count, 20001);
  const files = unzip(log.zip());
  const rows = files.get("transcript.jsonl").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 20001);
  assert.equal(rows[0].text, "発言0");
  assert.equal(rows.at(-1).text, "発言20000");
  assert.match(files.get("transcript.txt"), /参加者: 発言0/);
});
test("transcripts: partial write failure retries without duplication, ZIP includes unwritten", (t) => {
  let fail = false;
  const io = {
    ...fs,
    writeSync(fd, buffer, offset, length, position) {
      if (fail) {
        fs.writeSync(fd, buffer, offset, 3, position);
        throw Error("disk full");
      }
      return fs.writeSync(fd, buffer, offset, length, position);
    },
  };
  const log = setup(t, { io });
  log.add(entry(1));
  fail = true;
  log.add(entry(2));
  assert.ok(log.error);
  assert.equal(
    unzip(log.zip()).get("transcript.jsonl").trim().split("\n").length,
    2,
  );
  fail = false;
  log.add(entry(3));
  assert.equal(log.error, "");
  assert.deepEqual(
    fs
      .readFileSync(log.path, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .map((e) => e.text),
    ["発言1", "発言2", "発言3"],
  );
});
test("transcripts: unavailable folder is nonfatal; loss and shutdown records survive recovery", (t) => {
  let fail = true;
  const log = setup(t, {
    limit: 2,
    io: {
      ...fs,
      mkdirSync(...args) {
        if (fail) throw Error("denied");
        return fs.mkdirSync(...args);
      },
    },
  });
  log.add(entry(1));
  log.add(entry(2));
  log.add(entry(3));
  const rows = unzip(log.zip())
    .get("transcript.jsonl")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows.find((e) => e.reason === "unwritten").count, 1);
  assert.match(
    unzip(log.zip()).get("transcript.txt"),
    /記録できなかった行: 1件（書けない行の上限）/,
  );
  fail = false;
  log.flush();
  log.dropped("shutdown", 3);
  assert.match(unzip(log.zip()).get("transcript.txt"), /3件（終了の期限切れ）/);
  assert.equal(log.pending.length, 0);
});
test("transcripts: chat lines join the timeline at their acceptance time", (t) => {
  const log = setup(t);
  log.add(entry(20));
  log.chat({
    id: "m1",
    createdAt: 1700000000010,
    source: "Collector",
    characterId: "c1",
    speakerName: "メリッサ",
    text: "扉を開けます",
  });
  log.chat({
    id: "m2",
    createdAt: 1700000000030,
    source: "Player",
    speakerName: "冒険者",
    text: "続く",
  });
  assert.equal(log.count, 1);
  assert.equal(log.chats, 2);
  assert.equal(log.snapshot().chats, 2);
  const onDisk = fs
    .readFileSync(log.path, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(onDisk[1], {
    type: "chat",
    time: new Date(1700000000010).toISOString(),
    messageId: "m1",
    source: "Collector",
    characterId: "c1",
    speakerName: "メリッサ",
    text: "扉を開けます",
  });
  assert.equal(onDisk[2].characterId, null);
  const files = unzip(log.zip());
  assert.deepEqual(
    files
      .get("transcript.txt")
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\[[^\]]+\] /, "")),
    [
      "[チャット] メリッサ: 扉を開けます",
      "参加者: 発言20",
      "[チャット] 冒険者: 続く",
    ],
  );
  assert.deepEqual(
    files
      .get("transcript.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).type ?? "speech"),
    ["chat", "speech", "chat"],
  );
});
test("transcripts: empty archive contains two empty files", (t) => {
  assert.deepEqual([...unzip(setup(t).zip()).values()], ["", ""]);
});
