import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { request } from "node:http";
import { createApp } from "./http.mjs";
import { initialConfig } from "./store.mjs";
const extension = `chrome-extension://${"a".repeat(32)}`;
const other = `chrome-extension://${"b".repeat(32)}`;
async function setup(t) {
  const initial = initialConfig({});
  initial.provider.type = "mock";
  const app = createApp({
    initial,
    dataDir: mkdtempSync(join(tmpdir(), "chatter-")),
    localOrigin: "http://127.0.0.1:0",
    publicOrigin: "https://bridge.example",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, method = "GET", data, headers = {}) =>
    fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const command = async (command) =>
    (
      await call(
        "/api/v1/admin/commands",
        "POST",
        { command, commandId: randomUUID() },
        { Authorization: `Bearer ${app.store.secrets.admin}` },
      )
    ).json();
  const invite = new URL((await command("invite")).url).hash.slice(8);
  const r = await call(
    "/api/v1/chatter/join",
    "POST",
    { invite },
    { "X-Chatter-Origin": extension },
  );
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null);
  const credential = await r.json(),
    headers = {
      Authorization: `Bearer ${credential.token}`,
      "X-Chatter-Origin": extension,
    };
  return {
    ...app,
    base,
    call,
    command,
    invite,
    credential,
    headers,
    root: `/api/v1/rooms/${initial.roomId}/`,
  };
}
async function socket(a, origin = extension) {
  const ws = new WebSocket(a.base.replace("http:", "ws:") + "/ws", { origin }),
    messages = [];
  ws.on("message", (b) => messages.push(JSON.parse(b)));
  await once(ws, "open");
  return { ws, messages };
}
test("Chatter token scope, source identity, web Cookie isolation and session end", async (t) => {
  const a = await setup(t);
  assert.equal(
    (await a.call(a.root + "state", "GET", undefined, a.headers)).status,
    200,
  );
  // Fetch normalizes Host; use HTTP directly to exercise another allowed Host.
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(
      a.base + a.root + "state",
      {
        headers: { ...a.headers, Host: "bridge.example" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
  for (const Origin of [other, "https://evil.example"])
    assert.equal(
      (
        await a.call(a.root + "state", "GET", undefined, {
          ...a.headers,
          Origin,
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await a.call(a.root + "state", "GET", undefined, {
        Authorization: a.headers.Authorization,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await a.call(a.root + "state", "GET", undefined, {
        Cookie: `trpg_player=${a.credential.token}`,
        "X-Chatter-Origin": extension,
      })
    ).status,
    403,
  );
  assert.equal(
    (await a.call("/api/v1/rooms/other/state", "GET", undefined, a.headers))
      .status,
    403,
  );
  assert.equal(
    (await a.call("/api/v1/admin/state", "GET", undefined, a.headers)).status,
    401,
  );
  assert.equal(
    (await a.call("/api/v1/events", "POST", {}, a.headers)).status,
    401,
  );
  assert.equal(
    (
      await a.call(
        "/api/v1/chatter/join",
        "POST",
        { invite: a.invite },
        { Origin: "https://evil.example", "X-Chatter-Origin": extension },
      )
    ).status,
    403,
  );
  const web = await a.call("/api/v1/join", "POST", { invite: a.invite });
  const cookie = web.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await a.call(a.root + "state", "GET", undefined, { Cookie: cookie }))
      .status,
    200,
  );
  assert.equal(
    (
      await a.call(a.root + "state", "GET", undefined, {
        Authorization: `Bearer ${cookie.split("=")[1]}`,
        "X-Chatter-Origin": extension,
      })
    ).status,
    401,
  );
  const c = await (
    await a.call(
      a.root + "characters",
      "POST",
      { displayName: "旅人" },
      a.headers,
    )
  ).json();
  const sent = await a.call(
    a.root + "messages",
    "POST",
    {
      characterId: c.value.id,
      text: "こんにちは",
      source: "Collector",
      clientMessageId: randomUUID(),
      sessionId: a.engine.sessionId,
    },
    a.headers,
  );
  assert.equal(sent.status, 201);
  assert.equal(a.store.chat.list().messages[0].source, "Chatter");
  assert.equal(a.engine.collectors.size, 0);
  await a.command("end");
  assert.equal(
    (await a.call(a.root + "state", "GET", undefined, a.headers)).status,
    401,
  );
});
test("WS stays silent before authentication; leave revokes HTTP and WS", async (t) => {
  const a = await setup(t),
    s = await socket(a);
  a.engine.notify("characters.changed");
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(s.messages, []);
  s.ws.send(
    JSON.stringify({
      type: "hello",
      clientId: randomUUID(),
      token: a.credential.token,
    }),
  );
  await once(s.ws, "message");
  assert.equal(s.messages[0].type, "hello");
  const closed = once(s.ws, "close");
  assert.equal(
    (await a.call("/api/v1/leave", "POST", {}, a.headers)).status,
    200,
  );
  await closed;
  assert.equal(
    (await a.call(a.root + "state", "GET", undefined, a.headers)).status,
    401,
  );
  const bad = await socket(a),
    done = once(bad.ws, "close");
  bad.ws.send(
    JSON.stringify({
      type: "hello",
      clientId: randomUUID(),
      token: a.credential.token,
    }),
  );
  assert.equal((await done)[0], 1008);
  assert.deepEqual(bad.messages, []);
});
test("WS rejects another extension and limits unauthenticated connections", async (t) => {
  const a = await setup(t),
    bad = await socket(a, other),
    done = once(bad.ws, "close");
  bad.ws.send(
    JSON.stringify({
      type: "hello",
      clientId: randomUUID(),
      token: a.credential.token,
    }),
  );
  assert.equal((await done)[0], 1008);
  assert.deepEqual(bad.messages, []);
  const pending = await Promise.all(
    Array.from({ length: 10 }, () => socket(a)),
  );
  const extra = new WebSocket(a.base.replace("http:", "ws:") + "/ws", {
    origin: extension,
  });
  await once(extra, "error");
  assert.equal((await once(pending[0].ws, "close"))[0], 1008);
  assert.deepEqual(pending[0].messages, []);
});
test("expired participant credential cannot access HTTP or authenticate WS", async (t) => {
  const a = await setup(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 13 * 3600000);
  assert.equal(
    (await a.call(a.root + "state", "GET", undefined, a.headers)).status,
    401,
  );
  const s = await socket(a),
    done = once(s.ws, "close");
  s.ws.send(
    JSON.stringify({
      type: "hello",
      clientId: randomUUID(),
      token: a.credential.token,
    }),
  );
  assert.equal((await done)[0], 1008);
  assert.deepEqual(s.messages, []);
});
