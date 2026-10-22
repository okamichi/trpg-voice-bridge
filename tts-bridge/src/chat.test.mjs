import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createApp } from "./http.mjs";
import { Store, initialConfig } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { mockWav } from "./provider.mjs";

async function setup(t) {
  const initial = initialConfig({});
  initial.provider.type = "mock";
  const app = createApp({
    initial,
    dataDir: mkdtempSync(join(tmpdir(), "bridge-chat-")),
    localOrigin: "http://127.0.0.1:0",
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, method = "GET", data, cookie, extra = {}) =>
    fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
        ...(cookie ? { Cookie: cookie } : {}),
        ...extra,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const admin = (path, method, data) =>
    call("/api/v1/admin/" + path, method, data, null, {
      Authorization: `Bearer ${app.store.secrets.admin}`,
    });
  const invitation = await (
    await admin("commands", "POST", {
      command: "invite",
      commandId: randomUUID(),
    })
  ).json();
  const invite = new URL(invitation.url).hash.slice(8);
  const participate = async () => {
    const r = await call("/api/v1/join", "POST", { invite });
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie").split(";")[0];
  };
  const one = await participate(),
    two = await participate();
  const root = `/api/v1/rooms/${initial.roomId}/`;
  const c = await call(
    root + "characters",
    "POST",
    { displayName: "冒険者" },
    one,
  );
  assert.equal(c.status, 201);
  const character = (await c.json()).value;
  const input = (text = "こんにちは") => ({
    characterId: character.id,
    text,
    sessionId: app.engine.sessionId,
    clientMessageId: randomUUID(),
  });
  return { ...app, base, call, admin, root, one, two, character, input };
}
async function idle(engine) {
  for (let i = 0; i < 500 && (engine.busy || engine.queue.length); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(engine.busy, false);
}
async function socket(a, cookie) {
  const messages = [];
  const ws = new WebSocket(a.base.replace("http:", "ws:") + "/ws", {
    origin: a.base,
    headers: { Cookie: cookie },
  });
  ws.on("message", (data) => messages.push(JSON.parse(data)));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", clientId: randomUUID() }));
  for (
    let i = 0;
    i < 100 && !messages.some((m) => m.type === "state.snapshot");
    i++
  )
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(messages.some((m) => m.type === "state.snapshot"));
  return { ws, messages };
}

test("two participants create and share durable messages without Collector or TTS", async (t) => {
  const a = await setup(t);
  assert.deepEqual(a.character.bindings, []);
  assert.deepEqual(a.store.config.sources, []);
  const input = a.input();
  const first = await a.call(a.root + "messages", "POST", input, a.one);
  assert.equal(first.status, 201);
  const accepted = await first.json();
  const retry = await a.call(a.root + "messages", "POST", input, a.one);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).messageId, accepted.messageId);
  assert.equal(
    (
      await a.call(
        a.root + "messages",
        "POST",
        { ...input, text: "別の内容" },
        a.one,
      )
    ).status,
    409,
  );
  const history = await (
    await a.call(a.root + "messages", "GET", null, a.two)
  ).json();
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].text, input.text);
  assert.equal(history.messages[0].audioStatus, "ignored");
  assert.equal(a.engine.orders.size, 0);
  const reopened = new Store(a.store.dir, initialConfig({}));
  try {
    assert.equal(reopened.chat.get(accepted.messageId).text, input.text);
  } finally {
    reopened.close();
  }
  // Same client UUID belongs to different participants, never conflated.
  assert.equal(
    (await a.call(a.root + "messages", "POST", input, a.two)).status,
    201,
  );
});

test("authorization, session, character, content and rate limits protect chat", async (t) => {
  const a = await setup(t);
  for (const [input, status] of [
    [{ ...a.input(), sessionId: "old" }, 409],
    [{ ...a.input(), characterId: "other-room-character" }, 404],
    [a.input(" "), 422],
    [a.input("a".repeat(501)), 422],
    [a.input("<script>"), 422],
  ])
    assert.equal(
      (await a.call(a.root + "messages", "POST", input, a.one)).status,
      status,
    );
  assert.equal(
    (await a.call(a.root + "messages", "POST", a.input())).status,
    401,
  );
  assert.equal(
    (
      await a.call(
        a.root.replace("campaign-01", "other") + "messages",
        "GET",
        null,
        a.one,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await a.call(a.root + "messages", "POST", a.input(), a.one, {
        Origin: "https://evil.test",
      })
    ).status,
    403,
  );
  const b = a.input();
  await a.call(a.root + "messages", "POST", b, a.one);
  a.engine.rate = { tokens: 0, updated: Date.now() + 10000 };
  assert.equal(
    (await a.call(a.root + "messages", "POST", b, a.one)).status,
    200,
  );
  assert.equal(
    (await a.call(a.root + "messages", "POST", a.input(), a.one)).status,
    429,
  );
});

test("audio revisions recover completion and failures without creating new chat rows", async (t) => {
  const a = await setup(t);
  a.store.change((c) => {
    const defaults = initialConfig({
      v: {
        name: "声",
        voice: "none",
        caption: "明るい声",
        seed: "1",
        steps: 10,
        speed: 1,
      },
    });
    c.voiceProfiles = defaults.voiceProfiles;
    c.characters[0].voiceProfileId = c.voiceProfiles[0].id;
    c.sentenceSplitThresholdChars = 1;
  });
  a.engine.accepting = true;
  const baseline = a.store.chat.metadata();
  const b = a.input("こんにちは。次の文です。");
  const result = await (
    await a.call(a.root + "messages", "POST", b, a.one)
  ).json();
  await idle(a.engine);
  const changeResponse = await a.call(
    a.root +
      `message-changes?since=${baseline.updateSeq}&generation=${baseline.generation}`,
    "GET",
    null,
    a.two,
  );
  assert.equal(changeResponse.status, 200);
  const changes = (await changeResponse.json()).changes;
  const last = changes
    .filter((c) => c.message?.id === result.messageId)
    .at(-1).message;
  assert.equal(last.audioStatus, "ready");
  assert.equal(last.audioOrders.length, 2);
  assert.equal(a.store.chat.list().messages.length, 1);
  const count = a.engine.orders.size;
  await a.call(a.root + "messages", "POST", b, a.one);
  assert.equal(a.engine.orders.size, count);
  a.engine.degraded = true;
  const failed = await a.call(
    a.root + "messages",
    "POST",
    a.input("TTS停止中にも届く"),
    a.one,
  );
  assert.equal(failed.status, 201);
  const f = await failed.json();
  assert.equal(a.store.chat.get(f.messageId).audioStatus, "failed");
  a.engine.degraded = false;
  a.engine.maxAudioBytes = 0;
  const full = await (
    await a.call(
      a.root + "messages",
      "POST",
      a.input("容量不足でも届く"),
      a.one,
    )
  ).json();
  assert.equal(a.store.chat.get(full.messageId).audioStatus, "failed");
  assert.equal(a.store.chat.list().messages.length, 3);
});

test("sharing and clear invalidate old changes, block bodies, and preserve dedupe", async (t) => {
  const a = await setup(t);
  const connected = await socket(a, a.two);
  t.after(() => connected.ws.terminate());
  const b = a.input("消去対象");
  const r = await (await a.call(a.root + "messages", "POST", b, a.one)).json();
  const before = a.store.chat.metadata();
  await a.admin("subtitles", "PUT", {
    before: true,
    publishTextToPlayers: false,
  });
  assert.equal(
    (await a.call(a.root + "messages", "GET", null, a.one)).status,
    403,
  );
  assert.equal(
    (await a.call(a.root + "messages", "POST", a.input(), a.one)).status,
    403,
  );
  assert.equal(
    (
      await a.call(
        a.root + `message-changes?since=0&generation=1`,
        "GET",
        null,
        a.one,
      )
    ).status,
    403,
  );
  assert.equal(
    a.engine.history.some((n) => n.message?.text),
    false,
  );
  await a.admin("subtitles", "PUT", {
    before: false,
    publishTextToPlayers: true,
  });
  assert.equal(a.store.chat.get(r.messageId).text, b.text);
  const reset = await (
    await a.call(
      a.root +
        `message-changes?since=${before.updateSeq}&generation=${before.generation}`,
      "GET",
      null,
      a.one,
    )
  ).json();
  assert.equal(reset.resetRequired, true);
  assert.equal(
    (await a.call("/api/v1/admin/chat-history", "DELETE", null, a.one)).status,
    401,
  );
  await a.admin("chat-history", "DELETE");
  assert.equal(a.store.chat.list().messages.length, 0);
  const retry = await (
    await a.call(a.root + "messages", "POST", b, a.one)
  ).json();
  assert.equal(retry.deleted, true);
  assert.equal(a.store.chat.list().messages.length, 0);
  assert.equal(
    a.store.chat.update(r.messageId, { audioStatus: "ready" }),
    null,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(connected.messages.some((n) => n.type === "chat.reset"));
});

test("leave revokes all sockets of that credential, preserving another participant", async (t) => {
  const a = await setup(t);
  const connected = await socket(a, a.one);
  t.after(() => connected.ws.terminate());
  const closed = new Promise((resolve) => connected.ws.once("close", resolve));
  const left = await a.call("/api/v1/leave", "POST", {}, a.one);
  assert.equal(left.status, 200);
  assert.match(left.headers.get("set-cookie"), /Max-Age=0/);
  await closed;
  assert.equal(
    (await a.call(a.root + "messages", "GET", null, a.one)).status,
    401,
  );
  assert.equal(
    (await a.call(a.root + "messages", "GET", null, a.two)).status,
    200,
  );
  assert.equal(
    (
      await a.call(
        a.root + "characters",
        "POST",
        { displayName: "失効後" },
        a.one,
      )
    ).status,
    401,
  );
});

test("pagination, retention, restart recovery and atomic rollback", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "chat-store-"));
  const store = new Store(dir, initialConfig({}));
  t.after(() => store.close());
  const chat = store.chat;
  const input = (n) => ({
    text: `発言${n}`,
    sessionId: "current",
    source: "Player",
  });
  const a = chat.accept("a", "fa", input(1));
  const b = chat.accept("b", "fb", input(2));
  chat.accept("c", "fc", input(3));
  assert.deepEqual(
    chat.list({ before: 3, limit: 1 }).messages.map((m) => m.seq),
    [2],
  );
  assert.deepEqual(
    chat.list({ after: 1, limit: 1 }).messages.map((m) => m.seq),
    [2],
  );
  assert.equal(chat.list({ after: 1, limit: 1 }).hasMore, true);
  const before = chat.metadata();
  store.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON chat_receipts
    BEGIN SELECT RAISE(ABORT,'test rollback'); END`);
  assert.throws(() => chat.accept("fail", "ff", input(4)));
  store.db.exec("DROP TRIGGER fail_receipt");
  assert.deepEqual(chat.metadata(), before);
  assert.equal(chat.list().messages.length, 3);
  const engine = new Engine(store);
  try {
    assert.equal(chat.get(a.messageId).audioStatus, "interrupted");
    assert.equal(engine.orders.size, 0);
    // The legacy event ledger can expire without removing chat receipts.
    store.prune();
    const old = Date.now() - 8 * 86400000;
    store.db
      .prepare("UPDATE chat_messages SET created=? WHERE id=?")
      .run(old, a.messageId);
    chat.prune("current");
    assert.equal(chat.get(a.messageId), null);
    assert.equal(chat.lookup("a", "fa").deleted, true);
    assert.ok(chat.get(b.messageId));
    const changes = chat.changes({ since: 0, generation: 1 }).changes;
    assert.equal(
      changes.some((c) => c.message?.id === a.messageId),
      false,
    );
    assert.ok(
      changes.some(
        (c) => c.type === "chat.message.deleted" && c.messageId === a.messageId,
      ),
    );
  } finally {
    engine.close();
  }
});

test("Collector dedupe survives legacy ledger expiry and manual history clearing", async (t) => {
  const a = await setup(t);
  const source = { adapter: "fixture", instanceId: "vtt", contextId: "world" };
  a.store.change((c) => c.sources.push(source));
  a.engine.connect({ source, collectorId: "collector" });
  const event = {
    schemaVersion: 1,
    eventId: "evt",
    roomId: a.store.config.roomId,
    sessionId: a.engine.sessionId,
    source: { ...source, messageId: "original", revision: 0 },
    speaker: { kind: "character", id: "actor", name: "冒険者" },
    visibility: "public",
    kind: "dialogue",
    channel: "main",
    text: "VTTの新規発言",
    occurredAt: new Date().toISOString(),
  };
  const accepted = a.engine.ingress(event, "collector");
  a.store.db.exec("UPDATE events SET created=0");
  a.store.prune();
  assert.equal(
    a.store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n,
    0,
  );
  const retry = a.engine.ingress(event, "collector");
  assert.equal(retry.messageId, accepted.messageId);
  assert.equal(a.store.chat.list().messages.length, 1);
  assert.notEqual(
    a.store.chat.get(accepted.messageId).characterId,
    a.character.id,
  );
  await a.admin("chat-history", "DELETE");
  assert.equal(a.engine.ingress(event, "collector").deleted, true);
  assert.equal(a.store.chat.list().messages.length, 0);
  await a.admin("subtitles", "PUT", {
    before: true,
    publishTextToPlayers: false,
  });
  const hidden = a.engine.ingress(
    {
      ...event,
      source: { ...event.source, messageId: "hidden" },
    },
    "collector",
  );
  assert.equal(a.store.chat.get(hidden.messageId).text, event.text);
});

test("clear during generation cannot revive chat or audio captions; stale notifications are redacted", async (t) => {
  const a = await setup(t);
  const connected = await socket(a, a.two);
  t.after(() => connected.ws.terminate());
  a.store.change((c) => {
    const defaults = initialConfig({
      v: {
        name: "声",
        voice: "none",
        caption: "明るい声",
        seed: "1",
        steps: 10,
        speed: 1,
      },
    });
    c.voiceProfiles = defaults.voiceProfiles;
    c.characters[0].voiceProfileId = c.voiceProfiles[0].id;
    c.provider.type = "irodori";
  });
  let finish;
  a.engine.options.fetchImpl = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  a.engine.accepting = true;
  const input = a.input("後から届いても復活させない");
  const accepted = await (
    await a.call(a.root + "messages", "POST", input, a.one)
  ).json();
  assert.equal(typeof finish, "function");
  const stale = a.engine.history.find((m) => m.type === "chat.message.created");
  await a.admin("chat-history", "DELETE");
  const cut = connected.messages.length;
  a.engine.emit("notification", stale);
  finish(new Response(mockWav()));
  await idle(a.engine);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(a.store.chat.get(accepted.messageId), null);
  const snapshot = a.engine.snapshot();
  assert.equal(snapshot.orders[0].text, undefined);
  assert.equal(snapshot.orders[0].chatDeleted, true);
  assert.equal(
    a.engine.history.find((m) => m.type === "audio.ready").text,
    undefined,
  );
  assert.equal(
    connected.messages
      .slice(cut)
      .some((m) => m.message?.text === input.text || m.text === input.text),
    false,
  );
});

test("hostile strings remain data and prototype fields cannot change characters", async (t) => {
  const a = await setup(t);
  const text = `'); DROP TABLE chat_messages; -- $(echo injected) &lt;img src=x onerror=alert(1)&gt;`;
  const response = await a.call(
    a.root + "messages",
    "POST",
    a.input(text),
    a.one,
  );
  assert.equal(response.status, 201);
  const accepted = await response.json();
  assert.equal(a.store.chat.get(accepted.messageId).text, text);
  for (const bad of ["<img src=x onerror=alert(1)>", "\u0000bad"])
    assert.equal(
      (await a.call(a.root + "messages", "POST", a.input(bad), a.one)).status,
      422,
    );
  const displayName = `<svg onload=alert(1)>'); DROP TABLE characters; --`;
  const created = await a.call(
    a.root + "characters",
    "POST",
    { displayName },
    a.one,
  );
  assert.equal(created.status, 201);
  const character = (await created.json()).value;
  assert.equal(character.displayName, displayName);
  const value = JSON.parse(
    '{"__proto__":{"polluted":true},"displayName":"changed"}',
  );
  const rejected = await a.call(
    a.root + "characters/" + character.id,
    "PATCH",
    { before: character, value },
    a.one,
  );
  assert.equal(rejected.status, 422);
  assert.equal({}.polluted, undefined);
  assert.equal(
    a.store.config.characters.find((c) => c.id === character.id).displayName,
    displayName,
  );
  assert.equal(
    (
      await a.call(
        a.root + "messages",
        "POST",
        a.input("引き続き送信できます"),
        a.one,
      )
    ).status,
    201,
  );
});
