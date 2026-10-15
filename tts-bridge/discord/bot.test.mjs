import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot } from "./bot.mjs";
import { mockWav } from "../src/provider.mjs";
import { fakeEngine, fakeDiscord, tick, until } from "./test-helpers.mjs";
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
