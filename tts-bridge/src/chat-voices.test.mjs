import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./http.mjs";
import { Store, initialConfig } from "./store.mjs";
import { mockWav } from "./provider.mjs";
import {
  characterSettings,
  saveCharacter,
  removeCharacter,
} from "./character-settings.mjs";
import { VOICE_CONFIRMATION } from "./voice-defaults.mjs";
const source = { adapter: "fixture", instanceId: "test", contextId: "room" };
const register = "（ブリッジ声登録）透き通る女性の声";
const remove = "（ブリッジ声削除）";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await sleep(5);
  }
  assert.ok(fn(), "condition did not settle");
}
function gate() {
  let release;
  const promise = new Promise((r) => {
    release = r;
  });
  return { promise, release };
}
async function setup(t, fetchOverride) {
  const config = initialConfig({});
  config.chatVoiceRegistrationEnabled = true;
  config.sources = [source];
  const calls = [],
    uploads = [];
  const app = createApp({
    dataDir: mkdtempSync(join(tmpdir(), "chat-voices-")),
    initial: config,
    localOrigin: "http://127.0.0.1:0",
    providerOptions: {
      fetchImpl: async (url, init = {}) => {
        if (fetchOverride) {
          const result = await fetchOverride(url, init);
          if (result) return result;
        }
        if (url.endsWith("/v1/audio/speech")) {
          calls.push(JSON.parse(init.body));
          return new Response(mockWav());
        }
        if (init.method === "POST") {
          uploads.push({
            id: init.body.get("voice_id"),
            wav: Buffer.from(await init.body.get("file").arrayBuffer()),
          });
          return Response.json(
            { id: init.body.get("voice_id") },
            { status: 201 },
          );
        }
        return Response.json({ data: [] });
      },
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  app.engine.connect({ source, collectorId: "collector" });
  let sequence = 0;
  const event = (text, actor = "alice") => ({
    schemaVersion: 1,
    eventId: `e${++sequence}`,
    roomId: config.roomId,
    sessionId: app.engine.sessionId,
    source: { ...source, messageId: `m${sequence}`, revision: 0 },
    speaker: { kind: "character", id: actor, name: actor },
    channel: "main",
    kind: "dialogue",
    visibility: "public",
    text,
    occurredAt: new Date().toISOString(),
  });
  const send = (text, actor) =>
    app.engine.ingress(event(text, actor), "collector");
  const api = (path, body, token = app.store.secrets.admin) =>
    fetch(base + path, {
      method: body ? "PUT" : "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  t.after(() => app.close());
  return { ...app, base, event, send, api, calls, uploads, config };
}
async function idle(engine) {
  await until(
    () => !engine.busy && !engine.chatVoices.tasks.size && !engine.queue.length,
  );
}

test("first command registers exact preview, publishes fresh sequence and persists assignment", async (t) => {
  const hold = gate();
  const a = await setup(t, async (url) => {
    if (url.endsWith("speech")) await hold.promise;
  });
  a.engine.accepting = true;
  const notifications = [];
  a.engine.on("notification", (n) => notifications.push(n));
  const e = a.event(register);
  const result = a.engine.ingress(e, "collector");
  assert.equal(result.http, 202);
  assert.equal(a.engine.ingress(e, "collector").duplicate, true);
  const baseline = a.store.maxSeq();
  hold.release();
  await idle(a.engine);
  const ch = a.store.config.characters[0],
    voice = a.store.config.voiceProfiles[0];
  assert.equal(ch.voiceProfileId, voice.id);
  assert.equal(voice.voiceId, a.uploads[0].id);
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].input, VOICE_CONFIRMATION);
  const ready = notifications.filter((n) => n.type === "audio.ready");
  assert.equal(ready.length, 1);
  assert.ok(ready[0].orderSeq > baseline);
  assert.equal(ready[0].text, VOICE_CONFIRMATION);
  assert.deepEqual(
    readFileSync(a.engine.audioFile(ready[0].audio.id)),
    a.uploads[0].wav,
  );
  a.send("こんにちは");
  await idle(a.engine);
  assert.equal(a.calls[1].voice, voice.voiceId);
  const other = new Store(a.store.dir, a.config);
  assert.equal(other.config.characters[0].voiceProfileId, voice.id);
  other.close();
});

test("disabled commands and narration never generate or discover characters", async (t) => {
  const a = await setup(t);
  a.store.change((c) => {
    c.chatVoiceRegistrationEnabled = false;
    c.allowedKinds.push("narration");
  });
  assert.equal(a.send(register).status, "ignored");
  assert.equal(a.send(remove).status, "ignored");
  a.store.change((c) => {
    c.chatVoiceRegistrationEnabled = true;
  });
  assert.equal(
    a.engine.ingress({ ...a.event(register), kind: "narration" }, "collector")
      .status,
    "ignored",
  );
  assert.equal(a.store.config.characters.length, 0);
  assert.equal(a.calls.length, 0);
});

test("preflight failures have public fixed reasons, while unknown delete creates no character", async (t) => {
  const a = await setup(t);
  assert.equal(a.send(remove).status, "completed");
  assert.equal(a.store.config.characters.length, 0);
  assert.equal(a.send("（ブリッジ声登録） ").status, "failed");
  const id = a.store.config.characters[0].id;
  assert.equal(characterSettings(a.store).voiceStates[id].status, "failed");
  a.store.change((c) => {
    c.provider.type = "mock";
  });
  assert.match(a.send(register).reason, /モック/);
  a.store.change((c) => {
    c.provider.type = "irodori";
  });
  a.engine.degraded = true;
  assert.match(a.send(register).reason, /TTSが不調/);
  assert.equal(a.calls.length, 0);
  a.send(remove);
  assert.equal(characterSettings(a.store).voiceStates[id].status, "completed");
});

test("same character is excluded from Player edits, unrelated actors continue, delete cancels late generation", async (t) => {
  const hold = gate();
  const a = await setup(t, async (url) => {
    if (url.endsWith("speech")) await hold.promise;
  });
  a.send(register);
  const ch = structuredClone(a.store.config.characters[0]);
  assert.throws(
    () => saveCharacter(a.store, ch.id, { before: ch, value: {} }),
    { status: 409 },
  );
  assert.throws(() => removeCharacter(a.store, ch.id, { before: ch }), {
    status: 409,
  });
  assert.equal(a.send(register).status, "rejected");
  assert.match(a.store.voiceCommands.states()[ch.id].note, /追加/);
  assert.equal(a.send(register, "bob").status, "queued");
  const deletion = a.event(remove);
  a.engine.ingress(deletion, "collector");
  assert.equal(a.send(register).status, "queued");
  hold.release();
  await idle(a.engine);
  assert.equal(a.uploads.length, 2);
  assert.ok(a.store.config.characters.every((c) => c.voiceProfileId));
  const assigned = a.store.config.characters[0].voiceProfileId;
  a.engine.ingress(deletion, "collector");
  assert.equal(a.store.config.characters[0].voiceProfileId, assigned);
  assert.throws(
    () => saveCharacter(a.store, ch.id, { before: ch, value: {} }),
    { status: 409 },
  );
});

test("stop invalidates existing work, stopped acceptance may publish after start, stopped completion is not replayed", async (t) => {
  const hold = gate();
  const a = await setup(t, async (url) => {
    if (url.endsWith("speech")) await hold.promise;
  });
  a.send(register);
  a.engine.reset();
  const ch = a.store.config.characters[0];
  assert.match(a.store.voiceCommands.states()[ch.id].reason, /読み上げ停止/);
  a.send(register, "bob");
  a.engine.accepting = true;
  hold.release();
  await idle(a.engine);
  assert.equal(a.store.config.characters[0].voiceProfileId, null);
  assert.equal(a.engine.orders.size, 1);
  a.engine.reset();
  a.send(register, "carol");
  await idle(a.engine);
  const carol = a.store.config.characters.find(
    (c) => c.displayName === "carol",
  );
  assert.equal(a.store.voiceCommands.states()[carol.id].unplayed, true);
  const size = a.engine.orders.size;
  a.engine.accepting = true;
  a.engine.pump();
  assert.equal(a.engine.orders.size, size);
});

test("upload outside synthesis queue; Player gets 429 and listing remains available; shutdown awaits aborted upload", async (t) => {
  let started = false,
    aborted = false;
  const a = await setup(t, async (url, init) => {
    if (url.endsWith("voices") && init.method === "POST") {
      started = true;
      await new Promise((resolve, reject) =>
        init.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(init.signal.reason);
          },
          { once: true },
        ),
      );
    }
  });
  a.send(register);
  await until(() => started);
  assert.equal(a.engine.busy, false);
  const preview = await a.engine.preview("試聴", {
    ...a.store.config.voiceProfiles[0],
    id: "preview",
    name: "preview",
    provider: "irodori-local",
    voiceId: "none",
    caption: "",
    seed: "1",
    steps: 20,
    speed: 1,
  });
  assert.ok(preview.length);
  assert.throws(
    () =>
      a.engine.references.register({
        provider: a.store.config.provider,
        voiceId: "manual",
        wav: mockWav(),
      }),
    { status: 429 },
  );
  assert.deepEqual(await a.engine.references.list(a.store.config.provider), []);
  a.engine.chatVoices.shutdown();
  await a.engine.references.close();
  await a.engine.chatVoices.drain();
  assert.equal(aborted, true);
  const state = Object.values(a.store.voiceCommands.states())[0];
  assert.match(state.reason, /アプリ終了/);
});

test("upload failure keeps previous voice and never exposes upstream detail to players", async (t) => {
  let fail = false;
  const a = await setup(t, async (url, init) => {
    if (fail && url.endsWith("voices") && init.method === "POST")
      throw new Error("private upstream path /secret");
  });
  a.send(register);
  await idle(a.engine);
  const ch = a.store.config.characters[0],
    previous = ch.voiceProfileId;
  fail = true;
  a.send(register);
  await idle(a.engine);
  assert.equal(a.store.config.characters[0].voiceProfileId, previous);
  assert.equal(a.store.voiceCommands.states()[ch.id].status, "failed");
  assert.ok(!JSON.stringify(characterSettings(a.store)).includes("/secret"));
  assert.ok(
    JSON.stringify(a.store.voiceCommands.diagnostics()).includes("/secret"),
  );
});

test("DB commit failure rolls back assignment but records failure separately", async (t) => {
  const a = await setup(t, async (url, init) => {
    if (url.endsWith("voices") && init.method === "POST")
      a.store.db.exec(
        "CREATE TRIGGER reject_voice BEFORE INSERT ON voices BEGIN SELECT RAISE(FAIL, 'disk write rejected'); END;",
      );
  });
  a.send(register);
  await idle(a.engine);
  assert.equal(a.store.config.characters[0].voiceProfileId, null);
  assert.equal(a.store.config.voiceProfiles.length, 0);
  assert.equal(
    Object.values(a.store.voiceCommands.states())[0].status,
    "failed",
  );
  a.store.db.exec("DROP TRIGGER reject_voice");
});

test("setting defaults, authorization, conflict and OFF/ON cancellation", async (t) => {
  const hold = gate();
  const a = await setup(t, async (url) => {
    if (url.endsWith("speech")) await hold.promise;
  });
  const path = "/api/v1/admin/chat-voice-registration";
  assert.equal(
    (
      await a.api(
        path,
        { before: true, chatVoiceRegistrationEnabled: false },
        "wrong",
      )
    ).status,
    401,
  );
  assert.equal(
    (await a.api(path, { before: false, chatVoiceRegistrationEnabled: false }))
      .status,
    409,
  );
  assert.equal(
    (await a.api(path, { before: true, chatVoiceRegistrationEnabled: "false" }))
      .status,
    422,
  );
  a.send(register);
  assert.equal(
    (await a.api(path, { before: true, chatVoiceRegistrationEnabled: false }))
      .status,
    200,
  );
  assert.equal(
    (await a.api(path, { before: false, chatVoiceRegistrationEnabled: true }))
      .status,
    200,
  );
  hold.release();
  await idle(a.engine);
  assert.equal(a.store.config.characters[0].voiceProfileId, null);
  assert.equal(a.uploads.length, 0);
  assert.equal(initialConfig({}).chatVoiceRegistrationEnabled, false);
});

test("provider change and reset invalidate late results; reset preserves feature flag", async (t) => {
  const hold = gate();
  const a = await setup(t, async (url) => {
    if (url.endsWith("speech")) await hold.promise;
  });
  t.after(() => hold.release());
  const first = a.send(register);
  const provider = structuredClone(a.store.config.provider);
  assert.equal(
    (
      await a.api("/api/v1/admin/provider", {
        before: provider,
        baseUrl: "http://127.0.0.1:8089",
      })
    ).status,
    200,
  );
  assert.match(a.store.voiceCommands.get(first.orderId).reason, /接続先/);
  a.send(register, "bob");
  a.engine.reset(false, "設定リセットで中断しました");
  a.store.resetDefaults();
  assert.equal(a.store.config.chatVoiceRegistrationEnabled, true);
  assert.deepEqual(a.store.voiceCommands.states(), {});
  hold.release();
  await idle(a.engine);
  assert.deepEqual(a.store.voiceCommands.states(), {});
  assert.equal(a.uploads.length, 0);
});

test("concurrent registrations at 499 profiles cannot exceed 500", async (t) => {
  const hold = gate();
  const a = await setup(t, async (url, init) => {
    if (url.endsWith("voices") && init.method === "POST") await hold.promise;
  });
  t.after(() => hold.release());
  a.store.change((c) => {
    c.voiceProfiles = Array.from({ length: 499 }, (_, i) => ({
      id: `v${i}`,
      name: `v${i}`,
      provider: "irodori-local",
      voiceId: "none",
      caption: "",
      seed: "1",
      steps: 20,
      speed: 1,
    }));
  });
  const one = a.send(register, "alice");
  const two = a.send(register, "bob");
  await until(() => a.engine.references.queue.length === 1);
  assert.equal(a.engine.pendingMessages(), 2);
  assert.equal(a.engine.busy, false);
  hold.release();
  await idle(a.engine);
  assert.equal(a.store.config.voiceProfiles.length, 500);
  assert.equal(a.store.voiceCommands.get(one.orderId).status, "completed");
  assert.equal(a.store.voiceCommands.get(two.orderId).status, "failed");
  assert.equal(
    a.store.config.characters.filter((c) => c.voiceProfileId).length,
    1,
  );
});

test("restart cancels incomplete jobs; latest failure survives history pruning", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-restart-"));
  let store = new Store(dir, initialConfig({}));
  store.transaction(() =>
    store.voiceCommands.write({
      id: "unfinished",
      characterId: "alice",
      kind: "register",
      status: "generating",
    }),
  );
  store.close();
  store = new Store(dir, initialConfig({}));
  assert.equal(store.voiceCommands.busy("alice"), false);
  assert.match(store.voiceCommands.states().alice.reason, /再起動/);
  store.db
    .prepare("UPDATE voice_commands SET data=json_set(data, '$.updated', 0)")
    .run();
  store.voiceCommands.prune();
  assert.equal(store.voiceCommands.get("unfinished"), null);
  assert.equal(store.voiceCommands.states().alice.status, "failed");
  store.close();
});

test("rejected request note persists through stages and clears on completion", async (t) => {
  const hold = gate();
  const a = await setup(t, async (url, init) => {
    if (url.endsWith("voices") && init.method === "POST") await hold.promise;
  });
  a.send(register);
  await until(() => a.engine.references.running);
  const ch = a.store.config.characters[0];
  assert.equal(a.send(register).status, "rejected");
  assert.match(a.store.voiceCommands.states()[ch.id].note, /追加の登録/);
  hold.release();
  await idle(a.engine);
  assert.equal(a.store.voiceCommands.states()[ch.id].note, "");
});

test("generation queue limit includes registrations and stalled jobs expire without retry", async (t) => {
  const a = await setup(t);
  a.engine.maxAudioBytes = 1024 * 1024 * 1024;
  a.engine.busy = true; // Simulate another synthesis occupying the shared queue.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (let i = 0; i < 30; i++)
      assert.equal(a.send(register, `actor${i}`).status, "queued");
    a.engine.rate.tokens = 1;
    assert.match(a.send(register, "overflow").reason, /キューが満杯/);
    assert.equal(a.engine.pendingMessages(), 30);
    t.mock.timers.tick(180001);
    await a.engine.chatVoices.drain();
    assert.equal(a.engine.pendingMessages(), 0);
    assert.equal(a.engine.queue.length, 0);
    assert.equal(a.calls.length, 0);
    assert.ok(
      Object.values(a.store.voiceCommands.states()).every(
        (s) => s.status === "failed",
      ),
    );
  } finally {
    t.mock.timers.reset();
    a.engine.busy = false;
  }
});
