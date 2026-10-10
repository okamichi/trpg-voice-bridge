import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Store, initialConfig } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { createApp } from "./http.mjs";
import { mockWav, inspectWav, payload } from "./provider.mjs";
import { saveCharacter, removeCharacter } from "./character-settings.mjs";
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
    !readFileSync(join(dir, "bridge.sqlite")).includes(Buffer.from(e.text)),
  );
});
test("same text with different message IDs generates separate audio for each new message", async (t) => {
  const { engine } = setup(t);
  engine.ingress(event(engine, "a"), "one");
  engine.ingress(event(engine, "b"), "one");
  await idle(engine);
  assert.equal(engine.orders.size, 2);
  assert.equal(engine.audio.size, 2);
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
test("discovery while stopped, voice assignment and resume never replay old speech", async (t) => {
  const { engine, store } = setup(t);
  engine.accepting = false;
  const e = event(engine);
  e.speaker.id = "new";
  assert.equal(engine.ingress(e, "one").status, "ignored");
  const ch = store.config.characters.find((c) => c.voiceProfileId === null);
  assert.ok(ch);
  assert.equal(ch.bindings[0].speakerId, "new");
  saveCharacter(store, ch.id, {
    before: ch,
    value: { voiceProfileId: "melissa" },
  });
  engine.accepting = true;
  assert.equal(engine.ingress(e, "one").status, "ignored");
  assert.equal(engine.orders.size, 0);
  assert.equal(
    engine.ingress({ ...e, source: { ...e.source, messageId: "new" } }, "one")
      .status,
    "queued",
  );
  await idle(engine);
  assert.equal(engine.audio.size, 1);
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
test("SQL persistence, entity conflicts, unrelated edits and atomic rollback", (t) => {
  const { store, dir } = setup(t);
  const ch = structuredClone(store.config.characters[0]),
    voice = structuredClone(store.config.voiceProfiles[0]);
  store.change((c) => c.characters.push({ ...ch, id: "other", bindings: [] }));
  const other = structuredClone(store.config.characters[1]);
  saveCharacter(store, ch.id, {
    before: ch,
    value: { displayName: "新しい名前" },
  });
  saveCharacter(store, other.id, {
    before: other,
    value: { displayName: "別キャラ" },
  });
  assert.throws(
    () =>
      saveCharacter(store, ch.id, {
        before: ch,
        value: { displayName: "古い画面" },
      }),
    { status: 409 },
  );
  const latest = structuredClone(store.config.characters[0]);
  saveCharacter(store, ch.id, {
    before: latest,
    value: {},
    voiceBefore: voice,
    voice: { ...voice, caption: "静かな声" },
  });
  assert.throws(
    () =>
      saveCharacter(store, ch.id, {
        before: latest,
        value: {},
        voiceBefore: voice,
        voice: { ...voice, caption: "上書き" },
      }),
    { status: 409 },
  );
  const saved = structuredClone(store.config);
  assert.throws(
    () =>
      saveCharacter(store, ch.id, {
        before: latest,
        value: { displayName: "" },
        voiceBefore: null,
        voice: { ...voice, name: "新規" },
      }),
    { status: 422 },
  );
  assert.deepEqual(store.config, saved);
  assert.throws(
    () =>
      store.change((c) =>
        c.characters.push({ ...c.characters[0], id: "duplicate" }),
      ),
    { status: 409 },
  );
  const reopened = new Store(dir, config());
  assert.deepEqual(reopened.config, saved);
  assert.equal("revision" in reopened.config, false);
  assert.equal("revision" in reopened.config.voiceProfiles[0], false);
  reopened.close();
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
  engine.ingress(event(engine, "two"), "one");
  const before = structuredClone(store.config);
  removeCharacter(store, before.characters[0].id, {
    before: before.characters[0],
  });
  engine.configChanged(before);
  release();
  await idle(engine);
  assert.equal(engine.audio.size, 0);
  assert.deepEqual(store.config.voiceProfiles, before.voiceProfiles);
  assert.deepEqual(
    [...engine.orders.values()].map((o) => o.status),
    ["cancelled", "cancelled"],
  );
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
test("accepted speech keeps its voice snapshot; next speech uses saved changes", async (t) => {
  const { engine, store } = setup(t);
  engine.ingress(event(engine, "one"), "one");
  const before = structuredClone(store.config);
  const c = structuredClone(before);
  c.voiceProfiles[0].caption = "新しい声";
  store.save(c, before);
  engine.ingress(event(engine, "two"), "one");
  await idle(engine);
  assert.deepEqual(
    [...engine.orders.values()].map((o) => o.voice.caption),
    ["明るい声", "新しい声"],
  );
  assert.equal(engine.audio.size, 2);
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
test("Player deletion preserves shared voices, rejects stale edits and allows rediscovery", async (t) => {
  const a = await httpApp(t);
  const character = structuredClone(a.store.config.characters[0]);
  const other = {
    ...structuredClone(character),
    id: "companion",
    displayName: "相棒",
    bindings: [{ ...fixtureSource, speakerId: "companion" }],
  };
  a.store.change((c) => c.characters.push(other));
  const voices = structuredClone(a.store.config.voiceProfiles);
  const path = `/api/v1/rooms/campaign-01/characters/${character.id}`;
  assert.equal(
    (await a.call(path, "DELETE", { before: character }, null)).status,
    401,
  );
  const invitation = await (
    await a.call("/api/v1/admin/commands", "POST", {
      command: "invite",
      commandId: "delete-invite",
    })
  ).json();
  const joined = await a.call(
    "/api/v1/join",
    "POST",
    { invite: new URL(invitation.url).hash.slice(8) },
    null,
  );
  const headers = {
    Cookie: joined.headers.get("set-cookie").split(";")[0],
    "Idempotency-Key": "delete-character",
  };
  assert.equal(
    (
      await a.call(path, "DELETE", { before: character }, null, {
        ...headers,
        Origin: "https://evil.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await a.call(
        path.replace("campaign-01", "another"),
        "DELETE",
        { before: character },
        null,
        headers,
      )
    ).status,
    403,
  );
  const stale = await a.call(
    path,
    "DELETE",
    { before: { ...character, displayName: "古い名前" } },
    null,
    { ...headers, "Idempotency-Key": "stale-delete" },
  );
  assert.equal(stale.status, 409);
  assert.equal(a.store.config.characters.length, 2);
  assert.equal(
    (await a.call(path, "DELETE", { before: character }, null, headers)).status,
    200,
  );
  // A retried DELETE with the same operation key must not remove anything else.
  assert.equal(
    (await a.call(path, "DELETE", { before: character }, null, headers)).status,
    200,
  );
  assert.deepEqual(a.store.config.characters, [other]);
  assert.deepEqual(a.store.config.voiceProfiles, voices);
  assert.deepEqual(a.store.read().characters, [other]);
  assert.equal(
    (
      await a.call(
        path,
        "PATCH",
        { before: character, value: { displayName: "復活" } },
        null,
        headers,
      )
    ).status,
    404,
  );

  a.engine.connect({ source: fixtureSource, collectorId: "one" });
  a.engine.accepting = true;
  assert.equal(
    a.engine.ingress(event(a.engine, "rediscover"), "one").status,
    "ignored",
  );
  const restored = a.store.config.characters.find((c) => c.id !== other.id);
  assert.notEqual(restored.id, character.id);
  assert.equal(restored.voiceProfileId, null);
  assert.deepEqual(restored.bindings, character.bindings);
  assert.deepEqual(a.store.config.voiceProfiles, voices);
});
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
  const before = structuredClone(a.store.config.characters[0]);
  const b = { before, value: { displayName: "New" } };
  const h = { Cookie: cookie, "Idempotency-Key": "same" };
  const path = "/api/v1/rooms/campaign-01/characters/" + before.id;
  const c1 = await (await a.call(path, "PATCH", b, null, h)).json();
  const c2 = await (await a.call(path, "PATCH", b, null, h)).json();
  assert.equal(c1.value.id, c2.value.id);
  assert.equal(a.store.config.characters[0].displayName, "New");
  assert.equal(
    (
      await a.call(path, "PATCH", { ...b, value: { enabled: false } }, null, {
        Cookie: cookie,
      })
    ).status,
    409,
  );
  assert.equal((await a.call(path, "PATCH", b, null)).status, 401);
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
    (
      await a.call("/api/v1/admin/provider", "PUT", {
        before: before.provider,
        baseUrl: broken.provider.baseUrl,
      })
    ).status,
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
  assert.deepEqual(a.store.config, before);
});

test("management link, Collector approval persistence, automatic source registration and revocation", async (t) => {
  const a = await httpApp(t);
  const access = new URL(a.adminUrl()).hash.slice(8);
  const login = await a.call("/api/v1/admin-login", "POST", { access }, null, {
    Origin: a.base,
  });
  assert.equal(login.status, 200);
  const adminCookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await a.call("/api/v1/admin/config", "GET", null, null, {
        Cookie: adminCookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await a.call("/api/v1/admin-login", "POST", { access }, null, {
        Origin: "https://evil.test",
      })
    ).status,
    403,
  );
  const key = "1".repeat(64),
    extensionOrigin = "chrome-extension://aaaaaaaa";
  const pending = await (
    await a.call("/api/v1/pairings", "POST", { key }, null, {
      Origin: extensionOrigin,
    })
  ).json();
  assert.equal(pending.status, "pending");
  const list = await (await a.call("/api/v1/admin/pairings")).json();
  assert.equal(list[0].code, pending.code);
  await a.call("/api/v1/admin/pairings", "POST", {
    id: list[0].id,
    approve: true,
  });
  const approved = await (
    await a.call("/api/v1/pairings", "POST", { key }, null, {
      Origin: extensionOrigin,
    })
  ).json();
  assert.equal(approved.status, "approved");
  const headers = {
    Authorization: `Bearer ${approved.token}`,
    Origin: extensionOrigin,
  };
  const source = {
      adapter: "fvtt",
      instanceId: "auto-vtt",
      contextId: "new-world",
    },
    b = { source, collectorId: "extension" };
  assert.equal(
    (await a.call("/api/v1/collectors/connect", "POST", b, null, headers))
      .status,
    200,
  );
  assert.ok(a.store.config.sources.some((s) => s.contextId === "new-world"));
  const reopened = new Store(a.store.dir, config());
  assert.equal(
    reopened.db
      .prepare("SELECT count(*) AS n FROM auth WHERE key LIKE 'collector:%'")
      .get().n,
    1,
  );
  reopened.close();
  await a.call("/api/v1/admin/commands", "POST", {
    command: "release-collector",
    commandId: "release",
  });
  assert.equal(
    (await a.call("/api/v1/collectors/heartbeat", "POST", b, null, headers))
      .status,
    409,
  );
  await a.call("/api/v1/admin/commands", "POST", {
    command: "revoke-collectors",
    commandId: "revoke",
  });
  assert.equal(
    (await a.call("/api/v1/collectors/connect", "POST", b, null, headers))
      .status,
    401,
  );
});

test("reuses valid invitation, explicit renewal, reset keeps auth/provider/sources and stops playback", async (t) => {
  const a = await httpApp(t);
  const cmd = async (command, extra = {}) =>
    (
      await a.call("/api/v1/admin/commands", "POST", {
        command,
        commandId: randomId(),
        ...extra,
      })
    ).json();
  const invite = await cmd("invite");
  assert.equal((await cmd("invite")).url, invite.url);
  assert.notEqual((await cmd("renew-invite")).url, invite.url);
  a.store.change((c) => {
    c.provider.baseUrl = "http://127.0.0.1:9999";
    c.characters[0].displayName = "changed";
  });
  const secrets = structuredClone(a.store.secrets),
    sources = structuredClone(a.store.config.sources);
  a.engine.accepting = true;
  await cmd("reset-settings", { confirm: true });
  assert.equal(a.engine.accepting, false);
  assert.equal(a.store.config.characters[0].displayName, "メリッサ");
  assert.equal(a.store.config.provider.baseUrl, "http://127.0.0.1:9999");
  assert.deepEqual(a.store.secrets, secrets);
  assert.deepEqual(a.store.config.sources, sources);
  await cmd("start");
  await cmd("stop");
  assert.equal(a.engine.accepting, false);
});

test("reset validates new config defaults atomically and preserves connection settings", (t) => {
  const { store } = setup(t);
  const before = structuredClone(store.config);
  const bad = structuredClone(before);
  bad.characters[0].voiceProfileId = "missing";
  assert.throws(() => store.resetDefaults(bad), { status: 422 });
  assert.deepEqual(store.read(), before);
  const defaults = structuredClone(before);
  defaults.provider.baseUrl = "http://127.0.0.1:9998";
  defaults.characters[0].displayName = "初期キャラ";
  store.resetDefaults(defaults);
  assert.equal(store.config.characters[0].displayName, "初期キャラ");
  assert.deepEqual(store.config.provider, before.provider);
});

test("shared voice update affects all linked characters and new voice assignment is atomic", (t) => {
  const { store } = setup(t);
  const first = structuredClone(store.config.characters[0]);
  store.change((c) =>
    c.characters.push({ ...first, id: "second", bindings: [] }),
  );
  const voice = structuredClone(store.config.voiceProfiles[0]);
  saveCharacter(store, first.id, {
    before: first,
    value: {},
    voiceBefore: voice,
    voice: { ...voice, caption: "共有の変更" },
  });
  assert.equal(store.config.voiceProfiles.length, 1);
  assert.deepEqual(
    store.config.characters.map(
      (c) =>
        store.config.voiceProfiles.find((v) => v.id === c.voiceProfileId)
          .caption,
    ),
    ["共有の変更", "共有の変更"],
  );
  saveCharacter(store, first.id, {
    before: first,
    value: {},
    voiceBefore: null,
    voice: { ...voice, name: "新しい声" },
  });
  assert.equal(store.config.voiceProfiles.length, 2);
  assert.notEqual(
    store.config.characters[0].voiceProfileId,
    store.config.characters[1].voiceProfileId,
  );
  assert.deepEqual(store.config.characters[0].bindings, first.bindings);
});

test("player registers only a bridge-generated preview as a new reference voice", async (t) => {
  const a = await httpApp(t);
  const r = await a.call("/api/v1/admin/commands", "POST", {
    command: "invite",
    commandId: "invite-ref",
  });
  const invite = new URL((await r.json()).url).hash.slice(8);
  const join = await a.call("/api/v1/join", "POST", { invite }, null);
  const Cookie = join.headers.get("set-cookie").split(";")[0];
  const uploads = [];
  a.store.config.provider.type = "irodori";
  a.engine.options.fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/v1/audio/speech")) return new Response(mockWav());
    if (init.method === "POST") {
      uploads.push(init.body);
      return Response.json({ id: init.body.get("voice_id") }, { status: 201 });
    }
    return Response.json({
      data: [{ id: "none", no_ref: true }, { id: "taken" }],
    });
  };
  const room = "/api/v1/rooms/campaign-01";
  const preview = await a.call(
    room + "/previews",
    "POST",
    { text: "試聴", voice: a.store.config.voiceProfiles[0] },
    null,
    { Cookie },
  );
  assert.equal(preview.status, 200);
  const wav = Buffer.from(await preview.arrayBuffer()),
    previewId = preview.headers.get("x-preview-id");
  assert.ok(previewId);
  const register = (b) => a.call(room + "/voices", "POST", b, null, { Cookie });
  assert.equal((await register({ previewId, voiceId: "None" })).status, 422);
  assert.equal((await register({ previewId, voiceId: "../x" })).status, 422);
  assert.equal((await register({ previewId, voiceId: "taken" })).status, 409);
  assert.equal(
    (await register({ previewId: "unknown", voiceId: "fresh" })).status,
    404,
  );
  assert.equal(
    (
      await a.call(
        room + "/voices",
        "POST",
        { previewId, voiceId: "fresh" },
        null,
      )
    ).status,
    401,
  );
  assert.equal(uploads.length, 0);
  const ok = await register({ previewId, voiceId: "fresh" });
  assert.equal(ok.status, 201);
  assert.deepEqual(await ok.json(), { id: "fresh" });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].get("voice_id"), "fresh");
  assert.equal(uploads[0].get("file").name, "fresh.wav");
  assert.deepEqual(
    Buffer.from(await uploads[0].get("file").arrayBuffer()),
    wav,
  );
  a.engine.options.fetchImpl = async (url, init = {}) =>
    init.method === "POST"
      ? new Response("exists", { status: 409 })
      : Response.json({ data: [] });
  assert.equal((await register({ previewId, voiceId: "race" })).status, 409);
});

test("snapshot keeps generated text in memory for the Player log only while published", async (t) => {
  const { engine, store, dir } = setup(t);
  const r = engine.ingress(event(engine, "log", "ログに残るセリフ"), "one");
  await idle(engine);
  const ready = () =>
    engine.snapshot().orders.find((o) => o.orderId === r.orderId);
  assert.equal(ready().status, "ready");
  assert.equal(ready().text, "ログに残るセリフ");
  assert.equal(
    engine.history.find((n) => n.type === "audio.ready").text,
    "ログに残るセリフ",
  );
  assert.equal(
    engine.publicOrder(engine.orders.get(r.orderId)).text,
    undefined,
  );
  for (const f of ["bridge.sqlite", "bridge.sqlite-wal"])
    if (existsSync(join(dir, f)))
      assert.ok(
        !readFileSync(join(dir, f)).includes(Buffer.from("ログに残るセリフ")),
      );
  store.change((c) => {
    c.publishTextToPlayers = false;
  });
  assert.equal(ready().text, undefined);
  store.change((c) => {
    c.publishTextToPlayers = true;
  });
  const o = engine.orders.get(r.orderId);
  o.ready.retainUntil = 0;
  engine.audio.get(o.ready.audio.id).retainUntil = 0;
  engine.prune();
  assert.equal(ready(), undefined);
  const s = engine.ingress(event(engine, "after-reset", "停止で消える"), "one");
  await idle(engine);
  engine.reset();
  assert.equal(engine.orders.get(s.orderId).text, undefined);
  assert.deepEqual(engine.snapshot().orders, []);
});

test("admin toggles Player text with conflict detection; players cannot", async (t) => {
  const a = await httpApp(t);
  const put = (b, role = "admin") =>
    a.call("/api/v1/admin/subtitles", "PUT", b, role);
  assert.equal(a.store.config.publishTextToPlayers, true);
  assert.equal(
    (await put({ before: true, publishTextToPlayers: false }, "collector"))
      .status,
    401,
  );
  assert.equal(
    (await put({ before: true, publishTextToPlayers: "no" })).status,
    422,
  );
  assert.equal(
    (await put({ before: false, publishTextToPlayers: false })).status,
    409,
  );
  const ok = await put({ before: true, publishTextToPlayers: false });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { publishTextToPlayers: false });
  assert.equal(a.store.config.publishTextToPlayers, false);
  a.engine.connect({ source: fixtureSource, collectorId: "one" });
  a.engine.accepting = true;
  a.engine.ingress(event(a.engine, "hidden", "見せない"), "one");
  await idle(a.engine);
  const ready = a.engine.history.find((n) => n.type === "audio.ready");
  assert.equal(ready.text, undefined);
  assert.equal(a.engine.snapshot().orders[0].text, undefined);
});

test("Player replay plays on this page after the current sound, even when muted or late", async () => {
  const played = [];
  let release;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const meta = { bootId: "b", sessionId: "s", playbackEpoch: 1 };
  const p = new Playback({
    load: async (x) => x,
    play: (x) =>
      new Promise((r) => {
        played.push(x.orderId);
        release = r;
      }),
    stop: () => release?.(),
  });
  const item = (orderId, orderSeq, extra = {}) => ({
    ...meta,
    type: "audio.ready",
    orderId,
    orderSeq,
    characterId: "c",
    playBefore: Date.now() + 10000,
    ...extra,
  });
  p.reset(meta, 0);
  assert.equal(p.replay(item("early", 1)), false);
  p.enable();
  p.accept(item("live", 2));
  await tick();
  p.muted.add("c");
  assert.equal(p.replay(item("old", 1, { playBefore: 0 })), true);
  await tick();
  assert.deepEqual(played, ["live"]);
  release();
  await tick();
  assert.deepEqual(played, ["live", "old"]);
  p.muted.clear();
  p.accept(item("next", 3));
  assert.equal(p.replay(item("next", 3)), true);
  release();
  await tick();
  release();
  await tick();
  assert.deepEqual(played, ["live", "old", "next"]);
  assert.equal(p.replay(item("stale", 4, { playbackEpoch: 0 })), false);
  p.accept(item("live2", 5));
  await tick();
  p.replay(item("dropped", 4));
  p.reset({ ...meta, playbackEpoch: 2 }, 5);
  await tick();
  assert.deepEqual(played, ["live", "old", "next", "live2"]);
});
