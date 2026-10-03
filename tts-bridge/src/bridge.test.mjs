import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Store, initialConfig } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { createApp } from "./http.mjs";
import { mockWav, inspectWav, payload } from "./provider.mjs";
import { resolveCharacter } from "./contracts.mjs";
import { Playback } from "../web/playback.js";
const fixtureSource = {
  adapter: "fixture",
  instanceId: "test",
  contextId: "world",
};
const profiles = {
  melissa: {
    name: "メリッサ",
    voice: "none",
    caption: "明るい声",
    seed: "1520596899881326291",
    steps: 10,
    speed: 1,
  },
};
function config() {
  const c = initialConfig(profiles);
  c.provider.type = "mock";
  c.sources = [fixtureSource];
  c.characters[0].bindings = [{ ...fixtureSource, speakerId: "actor" }];
  return c;
}
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trpg-test-"));
  const store = new Store(dir, config()),
    engine = new Engine(store, options);
  engine.connect({ source: fixtureSource, collectorId: "one" });
  engine.accepting = true;
  t.after(() => {
    engine.close();
    store.close();
  });
  return { dir, store, engine };
}
function event(engine, messageId = "one", text = "こんにちは") {
  return {
    schemaVersion: 1,
    eventId: "evt-" + messageId,
    roomId: "campaign-01",
    sessionId: engine.sessionId,
    source: { ...fixtureSource, messageId, revision: 0 },
    speaker: { kind: "character", id: "actor", name: "メリッサ" },
    channel: "main",
    visibility: "public",
    kind: "dialogue",
    text,
    occurredAt: "2026-10-02T00:00:00.000Z",
  };
}
async function idle(engine) {
  for (let n = 0; n < 500 && (engine.busy || engine.queue.length); n++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(engine.busy, false);
}
test("persistent source-key dedupe ignores eventId and session, rejects content conflict", async (t) => {
  const { dir, store, engine } = setup(t);
  const e = event(engine),
    a = engine.ingress(e, "one");
  for (let i = 0; i < 10; i++)
    assert.equal(
      engine.ingress({ ...e, eventId: "retry-" + i }, "one").orderId,
      a.orderId,
    );
  assert.throws(() => engine.ingress({ ...e, text: "別の本文" }, "one"), {
    status: 409,
  });
  await idle(engine);
  assert.equal(engine.orders.size, 1);
  const other = new Store(dir, config());
  t.after(() => other.close());
  assert.equal(
    other.lookup(
      JSON.stringify(["campaign-01", "fixture", "test", "world", "one", 0]),
    ).status,
    "cancelled",
  );
  assert.ok(
    !readFileSync(join(dir, "ledger.sqlite")).includes(Buffer.from(e.text)),
  );
});
test("same text with different message IDs creates two orders sharing audio", async (t) => {
  const { engine } = setup(t);
  engine.ingress(event(engine, "a"), "one");
  engine.ingress(event(engine, "b"), "one");
  await idle(engine);
  assert.equal(engine.orders.size, 2);
  assert.equal(engine.audio.size, 1);
  assert.deepEqual(
    [...engine.orders.values()].map((x) => x.status),
    ["ready", "ready"],
  );
});
test("reject private, unknown, nonplaintext, oversized and wrong collectors", (t) => {
  const { engine } = setup(t);
  for (const visibility of ["private", "unknown"])
    assert.throws(
      () => engine.ingress({ ...event(engine), visibility }, "one"),
      { status: 422 },
    );
  assert.throws(() => engine.ingress(event(engine), "two"), { status: 403 });
  assert.throws(
    () => engine.connect({ source: fixtureSource, collectorId: "two" }),
    { status: 409 },
  );
  assert.throws(
    () => engine.ingress({ ...event(engine), text: "a".repeat(501) }, "one"),
    { status: 422 },
  );
  assert.throws(
    () => engine.ingress({ ...event(engine), text: "<secret>" }, "one"),
    { status: 422 },
  );
  assert.equal(engine.orders.size, 0);
});
test("unmapped utterance is never replayed by later binding", (t) => {
  const { engine, store } = setup(t);
  const e = event(engine);
  e.speaker.id = "new";
  assert.equal(engine.ingress(e, "one").status, "ignored");
  const c = structuredClone(store.config);
  c.characters[0].bindings.push({ ...fixtureSource, speakerId: "new" });
  store.save(c, c.revision);
  assert.equal(engine.ingress(e, "one").status, "ignored");
  assert.equal(engine.orders.size, 0);
  assert.equal(engine.unmapped.size, 1);
});
test("token override beats actor binding and disabled override does not fall back", (t) => {
  const { store } = setup(t),
    c = structuredClone(store.config);
  c.characters.push({
    ...c.characters[0],
    id: "npc",
    enabled: false,
    bindings: [{ ...fixtureSource, sceneId: "s", tokenId: "t" }],
  });
  const e = {
    source: fixtureSource,
    speaker: { id: "actor", sceneId: "s", tokenId: "t" },
  };
  assert.equal(resolveCharacter(c, e).id, "npc");
});
test("config persists, increments voice revisions, detects conflicts and duplicate bindings", (t) => {
  const { store, dir } = setup(t),
    c = structuredClone(store.config);
  c.voiceProfiles[0].caption = "静かな声";
  const saved = store.save(c, c.revision);
  assert.equal(saved.voiceProfiles[0].revision, 2);
  assert.throws(() => store.save(c, c.revision), { status: 409 });
  assert.equal(
    JSON.parse(readFileSync(join(dir, "config.json"))).voiceProfiles[0].caption,
    "静かな声",
  );
  const dup = structuredClone(saved);
  dup.characters.push({ ...dup.characters[0], id: "other" });
  assert.throws(() => store.save(dup, dup.revision), { status: 409 });
});
test("reset discards late synthesis result and cancels queued work", async (t) => {
  let release;
  const { engine, store } = setup(t, {
    fetchImpl: async () =>
      new Promise((r) => (release = () => r(new Response(mockWav())))),
  });
  store.config.provider.type = "irodori";
  engine.ingress(event(engine), "one");
  engine.ingress(event(engine, "two"), "one");
  engine.reset();
  release();
  await idle(engine);
  assert.equal(engine.audio.size, 0);
  assert.deepEqual(
    [...engine.orders.values()].map((o) => o.status),
    ["cancelled", "cancelled"],
  );
  assert.equal(
    engine.history.filter((x) => x.type === "audio.ready").length,
    0,
  );
});
test("character deletion discards late result and queued audio", async (t) => {
  let release;
  const { engine, store } = setup(t, {
    fetchImpl: async () =>
      new Promise((r) => (release = () => r(new Response(mockWav())))),
  });
  store.config.provider.type = "irodori";
  engine.ingress(event(engine), "one");
  const before = structuredClone(store.config);
  store.config.characters = [];
  engine.configChanged(before);
  release();
  await idle(engine);
  assert.equal(engine.audio.size, 0);
  assert.equal(engine.history.at(-1).type, "order.skipped");
});
test("failure lets next order advance; timeout requires explicit recovery", async (t) => {
  let calls = 0;
  const { engine, store } = setup(t, {
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new Error("upstream failure");
      return new Response(mockWav());
    },
  });
  store.config.provider.type = "irodori";
  engine.ingress(event(engine), "one");
  engine.ingress(event(engine, "two"), "one");
  await idle(engine);
  assert.deepEqual(
    [...engine.orders.values()].map((o) => o.status),
    ["failed", "ready"],
  );
  engine.options.fetchImpl = async () => {
    throw new DOMException("timeout", "TimeoutError");
  };
  engine.ingress(event(engine, "three", "別の文"), "one");
  await idle(engine);
  assert.equal(engine.degraded, true);
  assert.throws(() => engine.ingress(event(engine, "four"), "one"), {
    status: 503,
  });
});
test("profile snapshot, reference revision and runtime revision isolate cache", async (t) => {
  const { engine, store } = setup(t);
  engine.ingress(event(engine, "one"), "one");
  await idle(engine);
  const c = structuredClone(store.config);
  c.voiceProfiles[0].referenceRevision++;
  store.save(c, c.revision);
  engine.ingress(event(engine, "two"), "one");
  await idle(engine);
  assert.equal(engine.audio.size, 2);
  assert.equal([...engine.orders.values()][0].voice.referenceRevision, 1);
});
test("capacity backpressure and strict WAV validation", (t) => {
  const { engine } = setup(t, { maxAudioBytes: 100 });
  assert.throws(() => engine.ingress(event(engine), "one"), { status: 429 });
  assert.ok(inspectWav(mockWav()).durationMs > 0);
  const broken = mockWav();
  broken.writeUInt32LE(1, 28);
  assert.throws(() => inspectWav(broken));
  assert.throws(() => inspectWav(Buffer.from("{}")));
});
test("preview shares synthesis queue and never notifies participants", async (t) => {
  const { engine } = setup(t);
  const wav = await engine.preview("試聴", engine.config.voiceProfiles[0]);
  assert.ok(inspectWav(wav));
  assert.equal(engine.history.length, 0);
  assert.equal(engine.orders.size, 0);
  assert.match(
    payload(
      "こんにちは",
      engine.config.voiceProfiles[0],
      engine.config.provider,
    ),
    /"seed":1520596899881326291/,
  );
});
async function httpApp(t) {
  const app = createApp({
    dataDir: mkdtempSync(join(tmpdir(), "trpg-http-")),
    initial: config(),
    localOrigin: "http://127.0.0.1:0",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  const call = async (path, method = "GET", b, role = "admin", headers = {}) =>
    fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(role ? { Authorization: `Bearer ${app.store.secrets[role]}` } : {}),
        "Idempotency-Key": randomId(),
        ...headers,
      },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
  return { ...app, call, base };
}
function randomId() {
  return Math.random().toString(36).slice(2);
}
test("HTTP roles, invite cookie, room isolation, CRUD and idempotency", async (t) => {
  const a = await httpApp(t);
  assert.equal(
    (await a.call("/api/v1/admin/config", "GET", null, "collector")).status,
    401,
  );
  assert.equal(
    (
      await a.call("/api/v1/admin/config", "GET", null, "admin", {
        Origin: "https://evil.test",
      })
    ).status,
    403,
  );
  const command = { command: "invite", commandId: "invite-1" },
    r = await a.call("/api/v1/admin/commands", "POST", command);
  const invite = new URL((await r.json()).url).hash.slice(8);
  const join = await a.call("/api/v1/join", "POST", { invite }, null);
  assert.equal(join.status, 200);
  const cookie = join.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await a.call("/api/v1/rooms/campaign-01/state", "GET", null, null, {
        Cookie: cookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await a.call("/api/v1/rooms/another/state", "GET", null, null, {
        Cookie: cookie,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await a.call("/api/v1/admin/config", "GET", null, null, {
        Cookie: cookie,
      })
    ).status,
    401,
  );
  assert.equal(
    (await a.call("/api/v1/events", "POST", {}, null, { Cookie: cookie }))
      .status,
    401,
  );
  const b = {
    revision: 1,
    value: {
      ...a.store.config.characters[0],
      bindings: [],
      displayName: "New",
    },
  };
  const h = { "Idempotency-Key": "same" };
  const c1 = await (
      await a.call("/api/v1/admin/characters", "POST", b, "admin", h)
    ).json(),
    c2 = await (
      await a.call("/api/v1/admin/characters", "POST", b, "admin", h)
    ).json();
  assert.equal(c1.value.id, c2.value.id);
  assert.equal(a.store.config.characters.length, 2);
  assert.equal(
    (
      await a.call("/api/v1/admin/voice-profiles/melissa", "DELETE", {
        revision: 2,
      })
    ).status,
    409,
  );
  await a.call("/api/v1/admin/commands", "POST", {
    command: "end",
    commandId: "end",
  });
  assert.equal(
    (
      await a.call("/api/v1/rooms/campaign-01/state", "GET", null, null, {
        Cookie: cookie,
      })
    ).status,
    401,
  );
});
test("WS first join baseline excludes accepted work; resume and Origin enforcement", async (t) => {
  const a = await httpApp(t);
  a.engine.connect({ source: fixtureSource, collectorId: "one" });
  a.engine.accepting = true;
  a.engine.ingress(event(a.engine), "one");
  await idle(a.engine);
  const invite = new URL(
    (
      await (
        await a.call("/api/v1/admin/commands", "POST", {
          command: "invite",
          commandId: "invite",
        })
      ).json()
    ).url,
  ).hash.slice(8);
  const joined = await a.call("/api/v1/join", "POST", { invite }, null);
  const cookie = joined.headers.get("set-cookie").split(";")[0];
  const messages = [];
  const ws = new WebSocket(a.base.replace("http", "ws") + "/ws", {
    headers: { Origin: a.base, Cookie: cookie },
  });
  t.after(() => ws.terminate());
  ws.on("message", (x) => messages.push(JSON.parse(x)));
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "hello", clientId: "browser" }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(messages[0].baseline, 1);
  assert.equal(messages[0].resumed, false);
  assert.equal(messages.filter((x) => x.type === "audio.ready").length, 0);
  a.engine.ingress(event(a.engine, "two"), "one");
  await idle(a.engine);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(messages.at(-1).type, "audio.ready");
  const bad = new WebSocket(a.base.replace("http", "ws") + "/ws", {
    headers: { Origin: "https://evil.test", Cookie: cookie },
  });
  await new Promise((r) => bad.on("error", r));
  bad.terminate();
});
test("Player serializes playback, excludes baseline, skips muted and cancelled fetches", async () => {
  const played = [];
  let playing = 0,
    max = 0;
  const meta = { bootId: "boot", sessionId: "session", playbackEpoch: 1 };
  const p = new Playback({
    load: async (x) => {
      await new Promise((r) => setTimeout(r, x.orderSeq % 2 ? 5 : 1));
      return x;
    },
    play: async (x) => {
      playing++;
      max = Math.max(max, playing);
      played.push(x.orderSeq);
      await new Promise((r) => setTimeout(r, 2));
      playing--;
    },
    stop: () => {},
  });
  p.reset(meta, 1);
  for (let n = 1; n <= 10; n++)
    p.accept({
      ...meta,
      type: "audio.ready",
      orderId: String(n),
      orderSeq: n,
      characterId: n === 4 ? "muted" : "normal",
      playBefore: Date.now() + 10000,
    });
  p.muted.add("muted");
  p.accept({ ...meta, type: "order.skipped", orderId: "6" });
  p.enable();
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(played, [2, 3, 5, 7, 8, 9, 10]);
  assert.equal(max, 1);
});
test("Player reset or character skip during download cannot resurrect playback", async () => {
  let complete;
  const played = [];
  const meta = { bootId: "b", sessionId: "s", playbackEpoch: 1 };
  const p = new Playback({
    load: () => new Promise((r) => (complete = r)),
    play: async (a) => played.push(a),
    stop: () => {},
  });
  p.reset(meta, 0);
  p.enable();
  p.accept({
    ...meta,
    type: "audio.ready",
    orderId: "o",
    orderSeq: 1,
    playBefore: Date.now() + 1000,
  });
  p.reset({ ...meta, playbackEpoch: 2 }, 1);
  complete("old");
  await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(played, []);
});

test("explicit replay reuses audio without jumping ahead of a generating order", async (t) => {
  const { engine, store } = setup(t);
  const first = engine.ingress(event(engine, "first"), "one");
  await idle(engine);
  let release;
  store.config.provider.type = "irodori";
  engine.options.fetchImpl = () =>
    new Promise((r) => (release = () => r(new Response(mockWav()))));
  engine.ingress(event(engine, "second", "違うセリフ"), "one");
  const replay = engine.replay(first.orderId);
  assert.equal(replay.status, "queued");
  release();
  await idle(engine);
  assert.deepEqual(
    engine.history
      .filter((n) => n.type === "audio.ready")
      .map((n) => n.orderSeq),
    [1, 2, 3],
  );
  assert.equal(
    engine.orders.get(first.orderId).ready.audio.id,
    engine.orders.get(replay.orderId).ready.audio.id,
  );
});

test("short WS reconnect resumes missed notifications and epoch reset forces a fresh baseline", async (t) => {
  const a = await httpApp(t);
  a.engine.connect({ source: fixtureSource, collectorId: "one" });
  a.engine.accepting = true;
  const invite = new URL(
    (
      await (
        await a.call("/api/v1/admin/commands", "POST", {
          command: "invite",
          commandId: "resume-invite",
        })
      ).json()
    ).url,
  ).hash.slice(8);
  const joined = await a.call("/api/v1/join", "POST", { invite }, null),
    cookie = joined.headers.get("set-cookie").split(";")[0];
  async function connect(resume) {
    const messages = [],
      ws = new WebSocket(a.base.replace("http", "ws") + "/ws", {
        headers: { Origin: a.base, Cookie: cookie },
      });
    t.after(() => ws.terminate());
    ws.on("message", (b) => messages.push(JSON.parse(b)));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "hello", clientId: "same-page", resume }));
    await new Promise((r) => setTimeout(r, 20));
    return { ws, messages };
  }
  const first = await connect();
  const resume = { ...a.engine.metadata(), notificationSeq: 0 };
  first.ws.close();
  await new Promise((r) => first.ws.once("close", r));
  a.engine.ingress(event(a.engine, "offline"), "one");
  await idle(a.engine);
  const second = await connect(resume);
  assert.equal(second.messages[0].resumed, true);
  assert.equal(
    second.messages.filter((x) => x.type === "audio.ready").length,
    1,
  );
  second.ws.close();
  await new Promise((r) => second.ws.once("close", r));
  a.engine.reset();
  const third = await connect(resume);
  assert.equal(third.messages[0].resumed, false);
  assert.equal(third.messages[0].baseline, 1);
  assert.equal(
    third.messages.filter((x) => x.type === "audio.ready").length,
    0,
  );
});

test("reset aborts an in-flight Player fetch, so the new epoch is not blocked", async () => {
  const meta = { bootId: "b", sessionId: "s", playbackEpoch: 1 },
    played = [];
  let aborted = false;
  const p = new Playback({
    load: (item, signal) =>
      item.orderSeq === 1
        ? new Promise((resolve, reject) =>
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("cancelled", "AbortError"));
            }),
          )
        : Promise.resolve(item),
    play: async (item) => played.push(item.orderSeq),
    stop: () => {},
  });
  p.reset(meta, 0);
  p.enable();
  p.accept({
    ...meta,
    type: "audio.ready",
    orderId: "old",
    orderSeq: 1,
    playBefore: Date.now() + 1000,
  });
  p.reset({ ...meta, playbackEpoch: 2 }, 1);
  p.accept({
    ...meta,
    playbackEpoch: 2,
    type: "audio.ready",
    orderId: "new",
    orderSeq: 2,
    playBefore: Date.now() + 1000,
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(aborted, true);
  assert.deepEqual(played, [2]);
});

test("malformed config and unsupported voice options are rejected atomically", async (t) => {
  const a = await httpApp(t);
  const before = structuredClone(a.store.config);
  const broken = {
    ...before,
    provider: { ...before.provider, baseUrl: "file:///etc/passwd" },
  };
  assert.equal(
    (await a.call("/api/v1/admin/config", "PUT", broken)).status,
    422,
  );
  assert.deepEqual(a.store.config, before);
  assert.equal(
    (
      await a.call("/api/v1/admin/previews", "POST", {
        text: "test",
        voice: { ...before.voiceProfiles[0], ref_wav: "/etc/passwd" },
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await a.call("/api/v1/admin/config", "PUT", {
        revision: before.revision,
        roomId: before.roomId,
      })
    ).status,
    422,
  );
  assert.deepEqual(a.store.config, before);
});
