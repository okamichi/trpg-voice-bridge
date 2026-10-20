import test from "node:test";
import assert from "node:assert/strict";
import { ChatHistory } from "../web/chat-history.js";
import { BridgeClient } from "../web/bridge-client.js";
import { Playback } from "../web/playback.js";

const meta = {
  roomId: "room",
  bootId: "boot",
  sessionId: "session",
  chatGeneration: 1,
  chatEnabled: true,
};
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(history) {
  for (let i = 0; i < 100 && history.running; i++) await tick();
  assert.equal(history.running, false);
}
test("history restores audio revisions after a gap without playing audio; pagination follows all cursors", async () => {
  let calls = 0;
  const h = new ChatHistory({
    client: {
      room: (_, path) => path,
      json: async (path) => {
        calls++;
        if (path === "messages")
          return {
            generation: 1,
            updateSeq: 1,
            messages: [{ id: "a", seq: 1, updated: 1, audioStatus: "queued" }],
          };
        if (path.includes("since=1"))
          return {
            generation: 1,
            nextSince: 2,
            hasMore: true,
            changes: [
              {
                type: "chat.message.updated",
                message: { id: "a", seq: 1, updated: 2, audioStatus: "ready" },
              },
            ],
          };
        return {
          generation: 1,
          nextSince: 3,
          changes: [
            {
              type: "chat.message.created",
              message: { id: "b", seq: 2, updated: 3 },
            },
          ],
        };
      },
    },
  });
  h.state(meta);
  await settle(h);
  assert.equal(calls, 3);
  assert.equal(h.messages.get("a").audioStatus, "ready");
  assert.equal(h.messages.size, 2);
  assert.equal(h.cursor, 3);
});
test("an old in-flight history response cannot undo sharing OFF or leaving", async () => {
  let resolve;
  const h = new ChatHistory({
    client: {
      room: (_, p) => p,
      json: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
  });
  h.state(meta);
  h.state({
    ...meta,
    chatGeneration: 2,
    chatEnabled: false,
    // A previous state snapshot must not override newer hello metadata.
    chat: { generation: 1, enabled: true },
  });
  resolve({
    generation: 1,
    updateSeq: 1,
    messages: [{ id: "secret", updated: 1 }],
  });
  await settle(h);
  assert.equal(h.messages.size, 0);
  h.state({ ...meta, chatGeneration: 3 });
  h.stop();
  resolve({
    generation: 3,
    updateSeq: 2,
    messages: [{ id: "late", updated: 2 }],
  });
  await settle(h);
  assert.equal(h.messages.size, 0);
});
test("transport confines credentials to configured origin and cancels pending requests", async () => {
  let options;
  const client = new BridgeClient({
    baseUrl: "https://bridge.example",
    token: "participant",
    fetchImpl: async (url, init) => {
      options = init;
      return Response.json({ path: url.pathname });
    },
  });
  assert.deepEqual(await client.json("/test"), { path: "/test" });
  assert.equal(options.headers.Authorization, "Bearer participant");
  assert.equal(options.redirect, "error");
  assert.equal(options.credentials, "omit");
  await assert.rejects(
    client.json("https://another.example/test"),
    /別の接続先/,
  );
  const signal = options.signal;
  client.cancel();
  assert.equal(signal.aborted, true);
});
test("whole-message replay keeps sentence pauses and stops remaining parts on failure", async () => {
  const played = [],
    waits = [];
  let clock = 1000;
  const p = new Playback({
    load: async (item) => {
      if (item.orderId === "bad") throw new Error("expired");
      return item;
    },
    play: async (item) => {
      played.push(item.orderId);
    },
    stop: () => {},
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  const session = { sessionId: "s", playbackEpoch: 1 };
  p.reset(session, 0);
  p.enable();
  const item = (id, part) => ({
    ...session,
    orderId: id,
    orderSeq: part + 1,
    groupId: "g",
    part,
    parts: 3,
    pauseBeforeMs: part ? 900 : 0,
    retainUntil: 10000,
  });
  assert.equal(p.replay([item("a", 0), item("b", 1)]), true);
  while (p.running) await tick();
  assert.deepEqual(played, ["a", "b"]);
  assert.deepEqual(waits, [900]);
  p.replay([item("c", 0), item("bad", 1), item("never", 2)]);
  while (p.running) await tick();
  assert.deepEqual(played, ["a", "b", "c"]);
});
