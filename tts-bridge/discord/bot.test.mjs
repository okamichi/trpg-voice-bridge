import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot } from "./bot.mjs";
import { mockWav } from "../src/provider.mjs";
import {
  fakeEngine,
  fakeDiscord,
  fakeTranscription,
  tick,
  until,
} from "./test-helpers.mjs";
const A = "11111111111111111",
  B = "22222222222222222";
async function setup(t, options = {}) {
  const engine = fakeEngine(),
    fake = fakeDiscord(options);
  const dir = mkdtempSync(join(tmpdir(), "discord-bot-"));
  engine.file = join(dir, "audio.wav");
  writeFileSync(engine.file, mockWav());
  const bot = await createBot({
    engine,
    token: "secret",
    deps: fake.deps,
    ...options,
    timeouts: { greeting: 30, recover: 20, connect: 100, ...options.timeouts },
  });
  t.after(async () => {
    await bot.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const emit = (id, extra = {}) => {
    engine.seq++;
    engine.emit("notification", {
      ...engine.metadata(),
      type: "audio.ready",
      orderSeq: engine.seq,
      orderId: id,
      audio: { id },
      playBefore: Date.now() + 10000,
      ...extra,
    });
  };
  return { engine, bot, ...fake, emit };
}
test("Ready gates notification intake; initial subscribe, reset and enable; disconnect drops backlog", async (t) => {
  const f = await setup(t, { autoReady: false });
  const connecting = f.bot.connect(A, A);
  await until(() => f.connections.length);
  f.emit("old");
  assert.equal(f.resources.length, 0);
  f.connections[0].set("ready");
  await connecting;
  assert.ok(f.calls.includes("subscribe"));
  f.emit("new");
  await until(() => f.resources.length === 1);
  await f.bot.disconnect();
  f.emit("offline");
  const reconnecting = f.bot.connect(A, A);
  await until(() => f.connections.length === 2);
  f.connections[1].set("ready");
  await reconnecting;
  await tick();
  assert.equal(f.resources.length, 1);
  f.emit("live");
  await until(() => f.resources.length === 2);
});
test("greeting precedes queued sentences; skip/deadline are respected and sequence is ordered", async (t) => {
  let release;
  const greeting = new Promise((resolve) => {
    release = resolve;
  });
  const f = await setup(t, {
    greeting: (kind) => (kind === "enter" ? greeting : null),
    timeouts: { greeting: 500 },
  });
  const connecting = f.bot.connect(A, A);
  await until(() => f.bot.status().state === "connected");
  f.emit("second", { orderSeq: 2 });
  f.emit("first", { orderSeq: 1 });
  f.emit("skip", { orderSeq: 3 });
  f.engine.emit("notification", {
    ...f.engine.metadata(),
    type: "order.skipped",
    orderId: "skip",
  });
  f.emit("expired", { playBefore: 0 });
  const loaded = [];
  f.engine.audioFile = (id) => {
    loaded.push(id);
    return f.engine.file;
  };
  release(Buffer.alloc(100));
  await connecting;
  await until(() => f.resources.length === 3);
  assert.deepEqual(loaded, ["first", "second"]);
  assert.equal(f.resources[0].options.inputType, "raw");
});
test("reset stops active audio; new session resumes; async resource error cleans listeners and advances", async (t) => {
  const f = await setup(t, { autoIdle: false });
  await f.bot.connect(A, A);
  f.emit("one");
  await until(() => f.resources.length === 1);
  f.emit("two");
  const player = f.players[0];
  player.emit(
    "error",
    Object.assign(new Error("secret must not leak"), {
      resource: f.resources[0],
    }),
  );
  await until(() => f.resources.length === 2);
  assert.equal(player.listenerCount("error"), 2); // permanent + current resource only
  f.engine.meta.playbackEpoch++;
  f.engine.emit("notification", { type: "session.ended" });
  f.engine.meta.sessionId = "new-session";
  await tick();
  assert.equal(player.listenerCount("idle"), 0);
  assert.equal(player.listenerCount("error"), 1);
  f.emit("three");
  await until(() => f.resources.length === 3);
  assert.doesNotMatch(f.bot.status().error, /secret/);
  await f.bot.close();
  assert.equal(f.engine.listenerCount("notification"), 0);
});
test("synchronous playback failure does not escape Engine notification and next sentence plays", async (t) => {
  const f = await setup(t);
  await f.bot.connect(A, A);
  f.failNextPlay();
  assert.doesNotThrow(() => f.emit("one"));
  f.emit("two");
  await until(() => f.resources.length === 1);
});
test("short disconnect retains resource; failed recovery destroys connection and discards queue", async (t) => {
  const f = await setup(t, { autoIdle: false });
  await f.bot.connect(A, A);
  f.emit("one");
  await until(() => f.resources.length === 1);
  const connection = f.connections[0];
  connection.set("disconnected");
  connection.set("connecting");
  connection.set("ready");
  await tick();
  assert.equal(f.bot.status().state, "connected");
  assert.equal(f.resources.length, 1); // existing audio resource remains subscribed
  connection.set("disconnected");
  await until(() => f.bot.status().state === "error");
  assert.equal(connection.state.status, "destroyed");
  assert.equal(f.players[0].listenerCount("idle"), 0);
});
test("moving guilds unsubscribes and destroys the old connection", async (t) => {
  const f = await setup(t);
  await f.bot.connect(A, A);
  await f.bot.connect(B, B.slice(0, -1) + "1");
  assert.equal(f.connections[0].state.status, "destroyed");
  assert.equal(f.connections[1].state.status, "ready");
  assert.ok(f.calls.indexOf("unsubscribe") < f.calls.indexOf("destroy"));
});
test("greeting timeout never plays late audio; farewell is bounded and ignores incoming dialogue", async (t) => {
  let release;
  const f = await setup(t, {
    autoIdle: false,
    greeting: (kind) =>
      kind === "enter"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Buffer.alloc(100),
  });
  await f.bot.connect(A, A);
  release(Buffer.alloc(200));
  await tick();
  assert.equal(f.resources.length, 0);
  const disconnecting = f.bot.disconnect();
  f.emit("during-farewell");
  await disconnecting;
  assert.equal(f.resources.length, 1);
  assert.equal(f.connections[0].state.status, "destroyed");
});

test("same-guild moves reuse the connection without accumulating error listeners", async (t) => {
  const f = await setup(t);
  await f.bot.connect(A, A);
  await f.bot.connect(A, A.slice(0, -1) + "3");
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].joinConfig.channelId, A.slice(0, -1) + "3");
  assert.equal(f.connections[0].listenerCount("error"), 1);
  assert.equal(f.connections[0].listenerCount("stateChange"), 1);
});
test("reset while greeting is generating cancels the greeting and enables live dialogue", async (t) => {
  let release;
  const f = await setup(t, {
    greeting: (kind) =>
      kind === "enter"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : null,
    timeouts: { greeting: 500 },
  });
  const connecting = f.bot.connect(A, A);
  await until(() => f.bot.status().state === "connected");
  f.engine.meta.playbackEpoch++;
  f.engine.emit("notification", { type: "playback.reset" });
  await connecting;
  release(Buffer.alloc(100));
  await tick();
  assert.equal(f.resources.length, 0);
  f.emit("after-reset");
  await until(() => f.resources.length === 1);
});
test("close plays prepared farewell then destroys connection, and removes per-play listeners", async (t) => {
  const f = await setup(t, {
    greeting: (kind) => (kind === "leave" ? Buffer.alloc(100) : null),
  });
  await f.bot.connect(A, A);
  await f.bot.close();
  assert.equal(f.resources.length, 1);
  assert.ok(f.calls.indexOf("play") < f.calls.indexOf("destroy"));
  assert.equal(f.players[0].listenerCount("idle"), 0);
  assert.equal(f.players[0].listenerCount("error"), 0);
});
test("Mock Engine split speech plays in order, honors pauses, and continues after session end", async (t) => {
  const { Store, initialConfig } = await import("../src/store.mjs");
  const { Engine } = await import("../src/engine.mjs");
  const dir = mkdtempSync(join(tmpdir(), "discord-engine-"));
  const config = initialConfig({
    voice: {
      name: "Test",
      voice: "none",
      caption: "明るい声",
      seed: "1",
      steps: 10,
      speed: 1,
    },
  });
  const source = { adapter: "fixture", instanceId: "test", contextId: "world" };
  config.provider.type = "mock";
  config.sources = [source];
  config.characters[0].bindings = [{ ...source, speakerId: "actor" }];
  config.sentenceSplitThresholdChars = 1;
  config.sentencePauseMs = 40;
  const store = new Store(dir, config),
    engine = new Engine(store),
    fake = fakeDiscord();
  const loaded = [],
    times = [];
  const file = engine.audioFile.bind(engine);
  engine.audioFile = (id) => {
    loaded.push(id);
    times.push(Date.now());
    return file(id);
  };
  const bot = await createBot({ engine, token: "secret", deps: fake.deps });
  t.after(async () => {
    await bot.close();
    engine.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ready = [];
  engine.on("notification", (n) => {
    if (n.type === "audio.ready") ready.push(n);
  });
  await bot.connect(A, A);
  function post(id, text) {
    engine.connect({ source, collectorId: "test" });
    engine.accepting = true;
    engine.ingress(
      {
        schemaVersion: 1,
        eventId: id,
        roomId: config.roomId,
        sessionId: engine.sessionId,
        source: { ...source, messageId: id, revision: 0 },
        speaker: { kind: "character", id: "actor", name: "Test" },
        channel: "main",
        visibility: "public",
        kind: "dialogue",
        text,
        occurredAt: new Date().toISOString(),
      },
      "test",
    );
  }
  const started = [];
  const original = fake.players[0].play;
  fake.players[0].play = (resource) => {
    started.push(Date.now());
    original(resource);
  };
  post("one", "こんにちは。次の文です。");
  await until(() => fake.resources.length === 2);
  assert.deepEqual(
    loaded,
    ready.map((n) => n.audio.id),
  );
  assert.ok(started[1] - started[0] >= 30);
  engine.reset(true);
  await tick();
  post("two", "新しいセッションです。");
  await until(() => fake.resources.length === 3);
});

for (const mode of [
  "complete",
  "empty",
  "cancel-delay",
  "cancel-play",
  "timeout",
]) {
  test(`farewell delay lifecycle: ${mode}`, async (t) => {
    const leaveDelay = 40;
    const active = new Set();
    let scheduled = 0,
      finishedAt;
    const realSet = globalThis.setTimeout,
      realClear = globalThis.clearTimeout;
    t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
      let timer;
      timer = realSet(() => {
        active.delete(timer);
        fn(...args);
      }, ms);
      if (ms === leaveDelay) {
        scheduled++;
        active.add(timer);
      }
      return timer;
    });
    t.mock.method(globalThis, "clearTimeout", (timer) => {
      active.delete(timer);
      return realClear(timer);
    });
    const f = await setup(t, {
      autoIdle: mode !== "cancel-play",
      greeting: (kind) =>
        kind === "leave" ? Buffer.alloc(mode === "empty" ? 0 : 100) : null,
      timeouts: { greeting: mode === "timeout" ? 15 : 1000, leaveDelay },
    });
    await f.bot.connect(A, A);
    f.players[0].once("idle", () => {
      finishedAt = performance.now();
    });
    const leaving = f.bot.disconnect();
    if (mode === "cancel-delay" || mode === "cancel-play") {
      await until(() =>
        mode === "cancel-delay" ? scheduled === 1 : f.resources.length === 1,
      );
      f.engine.emit("notification", {
        ...f.engine.metadata(),
        type: "playback.reset",
        baseline: 0,
      });
    }
    await leaving;
    assert.ok(f.calls.includes("destroy"));
    assert.equal(active.size, 0);
    assert.equal(scheduled, ["empty", "cancel-play"].includes(mode) ? 0 : 1);
    if (mode === "complete")
      assert.ok(performance.now() - finishedAt >= leaveDelay - 1);
  });
}

const speechPcm = (seconds = 0.4) =>
  Buffer.alloc(Math.round(48000 * 4 * seconds), 1);
async function captureFixture(t, options = {}) {
  const transcription = options.transcription ?? fakeTranscription();
  const f = await setup(t, { transcription, ...options });
  f.guilds
    .get(A)
    .members.cache.set("alice", { displayName: "Alice", user: { bot: false } });
  f.guilds
    .get(A)
    .members.cache.set("robot", { displayName: "Robot", user: { bot: true } });
  await f.bot.connect(A, A);
  const receiver = f.connections[0].receiver;
  const say = async (id = "alice", duration = 0.4) => {
    receiver.speak(id, speechPcm(duration));
    await receiver.pause(id);
  };
  return { ...f, transcription, receiver, say };
}

test("disabled STT joins deaf and never installs a receiver", async (t) => {
  const f = await setup(t);
  await f.bot.connect(A, A);
  assert.equal(f.connections[0].joinConfig.selfDeaf, true);
  assert.equal(f.connections[0].receiver.speaking.listenerCount("start"), 0);
  assert.equal(f.bot.status().transcription.enabled, false);
});

test("delayed STT readiness undeafens once; errors stop capture and count unfinished requests", async (t) => {
  const stt = fakeTranscription(false);
  const f = await captureFixture(t, { transcription: stt });
  const c = f.connections[0];
  assert.equal(c.joinConfig.selfDeaf, true);
  assert.equal(f.receiver.speaking.listenerCount("start"), 0);
  stt.change(true);
  stt.change(true);
  assert.equal(c.joinConfig.selfDeaf, false);
  assert.equal(f.receiver.speaking.listenerCount("start"), 1);
  let signal;
  stt.transcribe = async (_wav, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };
  await f.say();
  await until(() => signal);
  await f.say();
  stt.change(false);
  assert.ok(signal.aborted);
  assert.equal(f.receiver.speaking.listenerCount("start"), 0);
  assert.equal(c.joinConfig.selfDeaf, true);
  assert.equal(f.bot.status().transcription.failed, 2);
  stt.change(false);
  assert.equal(f.bot.status().transcription.failed, 2);
  assert.deepEqual(stt.drops, [["error", 2]]);
  stt.transcribe = async () => "再開しました";
  stt.change(true);
  await f.say();
  await until(() => stt.entries.length === 1);
  assert.equal(stt.entries[0].text, "再開しました");
  assert.deepEqual(
    f.calls.filter((c) => Array.isArray(c) && c[0] === "rejoin"),
    [
      ["rejoin", { selfDeaf: false }],
      ["rejoin", { selfDeaf: true }],
      ["rejoin", { selfDeaf: false }],
    ],
  );
});

test("readiness changing before voice Ready is reconciled when the connection becomes ready", async (t) => {
  const stt = fakeTranscription(false);
  const f = await setup(t, { transcription: stt, autoReady: false });
  const connecting = f.bot.connect(A, A);
  await until(() => f.connections.length);
  assert.equal(f.connections[0].joinConfig.selfDeaf, true);
  stt.change(true);
  f.connections[0].set("ready");
  await connecting;
  assert.equal(f.connections[0].joinConfig.selfDeaf, false);
  assert.equal(f.connections[0].receiver.speaking.listenerCount("start"), 1);
});

test("capture labels human utterances, caches names and skips bots and short audio", async (t) => {
  const f = await captureFixture(t);
  assert.equal(f.connections[0].joinConfig.selfDeaf, false);
  f.receiver.speak("123", speechPcm());
  f.receiver.speak("robot", speechPcm());
  assert.equal(f.receiver.subscriptions.size, 0);
  await f.say("alice", 0.39);
  assert.equal(f.transcription.requests.length, 0);
  await f.say();
  await f.say();
  await until(() => f.transcription.entries.length === 2);
  const entry = f.transcription.entries[0];
  assert.equal(entry.speakerId, "alice");
  assert.equal(entry.speakerName, "Alice");
  assert.equal(entry.seconds, 0.4);
  assert.equal(typeof entry.time, "number");
  const wav = f.transcription.requests[0].wav;
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.length, 44 + 48000 * 2 * 0.4);
  assert.equal(
    f.calls.filter((c) => Array.isArray(c) && c[0] === "member").length,
    1,
  );
  assert.equal(f.bot.status().transcription.count, 2);
});

test("uncached bot identity is checked before subscribing and failed name lookup falls back to id", async (t) => {
  const f = await captureFixture(t);
  const guild = f.guilds.get(A);
  guild.members.fetch = async (id) => {
    if (id === "unknown-bot") return { user: { bot: true } };
    throw new Error("not found");
  };
  f.receiver.speak("unknown-bot", speechPcm());
  f.receiver.speak("unknown-person");
  await until(() => f.receiver.subscriptions.has("unknown-person"));
  assert.equal(f.receiver.subscriptions.has("unknown-bot"), false);
  f.receiver.speak("unknown-person", speechPcm());
  await f.receiver.pause("unknown-person");
  await until(() => f.transcription.entries.length === 1);
  assert.equal(f.transcription.entries[0].speakerName, "unknown-person");
});

test("disconnect, recovery and preserved connection moves flush capture without duplicate listeners", async (t) => {
  const f = await captureFixture(t);
  const c = f.connections[0];
  f.receiver.speak("alice", speechPcm());
  c.set("disconnected");
  assert.equal(f.receiver.speaking.listenerCount("start"), 0);
  c.set("ready");
  await until(() => f.transcription.entries.length === 1);
  await until(
    () =>
      f.receiver.subscriptions.has("alice") &&
      !f.receiver.subscriptions.get("alice").destroyed,
  );
  f.receiver.speak("alice", speechPcm());
  await f.bot.connect(A, A.slice(0, -1) + "3");
  await until(() => f.transcription.entries.length === 2);
  assert.equal(f.connections.length, 1);
  assert.equal(f.receiver.speaking.listenerCount("start"), 1);
  await until(
    () =>
      f.receiver.subscriptions.has("alice") &&
      !f.receiver.subscriptions.get("alice").destroyed,
  );
  await f.say();
  await until(() => f.transcription.entries.length === 3);
  await f.bot.disconnect({ farewell: false });
  assert.equal(f.receiver.speaking.listenerCount("start"), 0);
  f.transcription.change(true);
  assert.equal(f.receiver.speaking.listenerCount("start"), 0);
});

test("close flushes partial capture, drains results before farewell and prevents further intake", async (t) => {
  const stt = fakeTranscription();
  let resolve;
  stt.transcribe = () =>
    new Promise((r) => {
      resolve = r;
    });
  const order = [];
  stt.add = (entry) => {
    order.push("record");
    stt.entries.push(entry);
  };
  const f = await captureFixture(t, {
    transcription: stt,
    greeting: (kind) => {
      if (kind === "leave") order.push("farewell");
      return null;
    },
  });
  f.receiver.speak("alice", speechPcm());
  const closing = f.bot.close();
  assert.equal(f.receiver.speaking.listenerCount("start"), 0);
  f.receiver.speak("late", speechPcm());
  await until(() => resolve);
  resolve("途中の発言も保存");
  await closing;
  assert.deepEqual(order, ["record", "farewell"]);
  assert.equal(stt.entries.length, 1);
  assert.equal(stt.listeners.size, 0);
  assert.deepEqual(stt.drops, []);
});

test("shutdown deadline aborts in-flight work and drops the exact remaining count even if service ignores abort", async (t) => {
  const stt = fakeTranscription();
  let signal, resolve;
  stt.transcribe = (_wav, opts) => {
    signal = opts.signal;
    return new Promise((r) => {
      resolve = r;
    });
  };
  const f = await captureFixture(t, {
    transcription: stt,
    timeouts: { transcription: 20 },
  });
  await f.say();
  await until(() => signal);
  await f.say();
  f.receiver.speak("alice", speechPcm());
  await f.bot.close();
  assert.ok(signal.aborted);
  assert.deepEqual(stt.drops, [["shutdown", 3]]);
  resolve("遅すぎる結果");
  await tick();
  assert.equal(stt.entries.length, 0);
  assert.equal(f.bot.status().transcription.dropped, 3);
});

test("backlog keeps at most 200 queued utterances and evicts the oldest", async (t) => {
  const stt = fakeTranscription();
  let release;
  const seen = [];
  stt.transcribe = async (wav) => {
    seen.push(wav.readInt16LE(44));
    if (seen.length === 1)
      await new Promise((r) => {
        release = r;
      });
    return "発言";
  };
  const f = await captureFixture(t, { transcription: stt });
  for (let n = 1; n <= 203; n++) {
    const pcm = speechPcm();
    for (let offset = 0; offset < pcm.length; offset += 2)
      pcm.writeInt16LE(n, offset);
    f.receiver.speak("alice", pcm);
    await f.receiver.pause("alice");
  }
  assert.equal(f.bot.status().transcription.pending, 200);
  assert.deepEqual(stt.drops, [
    ["backlog", 1],
    ["backlog", 1],
  ]);
  release();
  await until(() => stt.entries.length === 201);
  assert.deepEqual(seen, [1, ...Array.from({ length: 200 }, (_, i) => i + 4)]);
});

test("echo comparison survives a transcription wait over 60 seconds and deleted orders", async (t) => {
  const stt = fakeTranscription();
  const text = "ファイアボールを唱えます。味方は少し下がってください。";
  let resolve;
  stt.transcribe = () =>
    new Promise((r) => {
      resolve = r;
    });
  const f = await captureFixture(t, { transcription: stt, autoIdle: false });
  f.engine.orderText = () => text;
  f.emit("reading");
  await until(() => f.resources.length === 1);
  await f.say();
  await until(() => resolve);
  f.players[0].emit("idle");
  f.engine.orderText = () => null;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 120000 });
  // Trigger history pruning with another completed capture before resolving.
  await f.say();
  resolve(text);
  await until(() => f.bot.status().transcription.pending === 0);
  resolve("扉を開けて中に入ります");
  await until(() => stt.entries.length === 1);
  assert.equal(stt.entries[0].text, "扉を開けて中に入ります");
});

test("greeting text participates in echo filtering", async (t) => {
  const stt = fakeTranscription();
  const text = "声の準備が整いました。物語を始めましょう。";
  stt.transcribe = async () => text;
  const f = await captureFixture(t, {
    transcription: stt,
    greetingText: () => text,
    greeting: (kind) => (kind === "enter" ? Buffer.alloc(100) : null),
  });
  await f.say();
  await tick();
  assert.equal(stt.entries.length, 0);
});

test("STT and packet failures are throttled and do not stop speech playback", async (t) => {
  const errors = [],
    stt = fakeTranscription();
  stt.transcribe = async () => {
    throw new Error("private service details");
  };
  const f = await captureFixture(t, {
    transcription: stt,
    onError: (e) => errors.push(e),
  });
  await f.say();
  await f.say();
  f.receiver.speak("alice", Buffer.from([255]), Buffer.from([255]));
  await f.receiver.pause("alice");
  f.emit("still-playing");
  await until(() => f.resources.length === 1);
  assert.equal(errors.filter((e) => e.includes("文字起こしに失敗")).length, 1);
  assert.equal(errors.filter((e) => e.includes("パケット")).length, 1);
  assert.equal(f.bot.status().transcription.failed, 2);
  assert.deepEqual(stt.drops, [
    ["error", 1],
    ["error", 1],
  ]);
  assert.doesNotMatch(errors.join(" "), /private service details/);
});
