import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, overlap, EchoGuard } from "./echo.mjs";

const READ =
  "ファイアボールを唱えます。待って、味方が範囲に入っているから、少し下がってから撃って。";
// What qwen3-asr-0.6b heard when READ, spoken by qwen3-tts-0.6b, was fed to it.
const HEARD =
  "ファイヤーボールを与えます。待って味方が範囲に入っているから少し下がってから撃って。";

test("normalize drops punctuation and spaces and folds katakana", () => {
  assert.equal(normalize("ファイア・ボール！ ｶﾀﾅ"), "ふぁいあぼーるかたな");
});

test("overlap is high for the reading as recognized", () => {
  assert.equal(overlap(READ, READ), 1);
  assert.ok(overlap(HEARD, READ) >= 0.8);
  // A piece of the reading, such as its tail picked up late.
  assert.ok(overlap("少し下がってから撃って", READ) >= 0.9);
});

test("overlap is low for something else said", () => {
  assert.ok(overlap("じゃあ扉を開けて中を覗き込みます", READ) < 0.2);
  assert.equal(overlap("", READ), 0);
  assert.equal(overlap("。", READ), 0);
  assert.equal(overlap("待", READ), 1);
  assert.equal(overlap("扉", READ), 0);
});

function guard(options) {
  let now = 0;
  const g = new EchoGuard({ now: () => now, ...options });
  g.at = (ms) => (now = ms);
  return g;
}

test("an utterance during the reading that says it is an echo", () => {
  const g = guard();
  g.at(1000);
  const reading = g.playing(READ);
  assert.ok(g.echoes(HEARD, 1200, 8000));
  g.at(9000);
  reading.end();
  assert.ok(g.echoes(HEARD, 1200, 9500));
  // Something else said over the reading is kept.
  assert.ok(!g.echoes("じゃあ扉を開けて中を覗き込みます", 2000, 4000));
});

test("only utterances near the reading are compared", () => {
  const g = guard();
  g.at(1000);
  g.playing(READ);
  g.at(9000);
  g.readings[0].end = 9000;
  assert.ok(g.echoes(HEARD, 10500, 12000)); // within the 2s tail
  assert.ok(!g.echoes(HEARD, 11500, 13000)); // after it
  assert.ok(!g.echoes(HEARD, 0, 900)); // before the reading
});

test("threshold 0 turns the guard off, and old readings are forgotten", () => {
  const off = guard({ threshold: 0 });
  off.playing(READ);
  assert.ok(!off.echoes(READ, 0, 1));
  const g = guard({ keepMs: 5000 });
  g.at(0);
  g.playing(READ).end();
  g.at(6000);
  assert.ok(!g.echoes(READ, 0, 1));
  assert.equal(g.readings.length, 0);
});

test("captured readings survive pruning and share their eventual end timestamp", () => {
  const g = guard();
  g.at(1000);
  const reading = g.playing(READ);
  const captured = g.snapshot(1200, 2000);
  assert.equal(captured[0], g.readings[0]);
  assert.equal(captured[0].end, Infinity);
  g.at(3000);
  reading.end();
  assert.equal(captured[0].end, 3000);
  g.at(120000);
  assert.deepEqual(g.snapshot(119000, 120000), []);
  assert.equal(g.readings.length, 0);
  assert.ok(g.echoes(HEARD, 1200, 2000, captured));
  assert.ok(!g.echoes("扉を開けます", 1200, 2000, captured));
  assert.ok(!g.echoes(HEARD, 6000, 7000, captured));
});
