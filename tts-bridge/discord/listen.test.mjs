import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { Readable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { listen, serial } from "./listen.mjs";

const FRAME = 960 * 4;

// Stands in for @discordjs/voice's VoiceReceiver: streams end when the test
// says, as AfterSilence ends them after a pause.
function receiver() {
  const speaking = new EventEmitter();
  speaking.users = new Map();
  const subscriptions = new Map();
  const options = [];
  return {
    speaking,
    subscriptions,
    options,
    subscribe(userId, opts) {
      if (subscriptions.has(userId)) return subscriptions.get(userId);
      options.push(opts);
      const stream = new Readable({ objectMode: true, read() {} });
      stream.once("close", () => subscriptions.delete(userId));
      subscriptions.set(userId, stream);
      return stream;
    },
    speak(userId, ...packets) {
      if (!speaking.users.has(userId)) {
        speaking.users.set(userId, Date.now());
        speaking.emit("start", userId);
      }
      for (const p of packets) subscriptions.get(userId)?.push(p);
    },
    async pause(userId) {
      speaking.users.delete(userId);
      const stream = subscriptions.get(userId);
      stream.push(null);
      stream.resume();
      await once(stream, "close");
    },
  };
}

// Each packet decodes to one 20ms frame filled with the packet's first byte.
const decoders = [];
const decoder = () => {
  const d = {
    deleted: false,
    decode(packet) {
      if (packet[0] === 0xff) throw new Error("damaged");
      return Buffer.alloc(FRAME, packet[0]);
    },
    delete() {
      d.deleted = true;
    },
  };
  decoders.push(d);
  return d;
};
const packet = (n) => Buffer.from([n]);

test("each utterance belongs to the stream it came from", async () => {
  const r = receiver(),
    got = [];
  listen(r, {
    decoder,
    endBehavior: 1,
    silenceMs: 700,
    onUtterance: (u) => got.push(u),
  });
  r.speak("alice", packet(1));
  r.speak("bob", packet(2), packet(2));
  r.speak("alice", packet(1));
  await r.pause("bob");
  await r.pause("alice");
  assert.deepEqual(r.options, [
    { end: { behavior: 1, duration: 700 } },
    { end: { behavior: 1, duration: 700 } },
  ]);
  assert.deepEqual(
    got.map((u) => [u.userId, u.pcm.length / FRAME, u.pcm[0]]),
    [
      ["bob", 2, 2],
      ["alice", 2, 1],
    ],
  );
  assert.ok(got.every((u) => u.startedAt instanceof Date));
  assert.ok(decoders.slice(-2).every((d) => d.deleted));
});

test("a long utterance is handed over in pieces", async () => {
  const r = receiver(),
    got = [];
  listen(r, { decoder, maxSeconds: 0.04, onUtterance: (u) => got.push(u) });
  r.speak("alice", packet(1), packet(1), packet(1), packet(1), packet(1));
  // A stream starts flowing on the tick after its "data" listener.
  await tick();
  assert.deepEqual(
    got.map((u) => u.pcm.length / FRAME),
    [2, 2],
  );
  await r.pause("alice");
  assert.deepEqual(
    got.map((u) => u.pcm.length / FRAME),
    [2, 2, 1],
  );
});

test("a damaged packet is skipped and stream errors are reported", async () => {
  const r = receiver(),
    got = [],
    errors = [];
  listen(r, {
    decoder,
    onUtterance: (u) => got.push(u),
    onError: (e) => errors.push(e.message),
  });
  r.speak("alice", packet(1), packet(0xff), packet(1));
  r.subscriptions.get("alice").destroy(new Error("decrypt"));
  await tick();
  assert.deepEqual(errors, ["damaged", "decrypt"]);
  assert.deepEqual(
    got.map((u) => u.pcm.length / FRAME),
    [2],
  );
});

test("ignored members are never subscribed", () => {
  const r = receiver();
  listen(r, {
    decoder,
    ignore: (id) => id === "bot",
    onUtterance: () => assert.fail(),
  });
  r.speak("bot", packet(1));
  assert.equal(r.subscriptions.size, 0);
});

test("speaking again while the old stream closes subscribes anew", async () => {
  const r = receiver(),
    got = [];
  listen(r, { decoder, onUtterance: (u) => got.push(u) });
  r.speak("alice", packet(1));
  const old = r.subscriptions.get("alice");
  old.push(null);
  old.resume();
  // The member speaks before the ended stream has closed.
  r.speaking.users.set("alice", Date.now());
  await once(old, "close");
  assert.notEqual(r.subscriptions.get("alice"), old);
  r.speak("alice", packet(3));
  await r.pause("alice");
  assert.deepEqual(
    got.map((u) => u.pcm[0]),
    [1, 3],
  );
});

test("stopping hands over what was being said", async () => {
  const r = receiver(),
    got = [];
  const stop = listen(r, { decoder, onUtterance: (u) => got.push(u) });
  r.speak("alice", packet(1));
  stop();
  await tick();
  assert.equal(got.length, 1);
  r.speaking.users.clear();
  r.speak("alice", packet(1));
  assert.equal(r.subscriptions.size, 0);
});

test("serial runs tasks one at a time in order", async () => {
  const run = serial(),
    order = [];
  let running = 0;
  const task = (n, ms) => async () => {
    assert.equal(++running, 1);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(n);
    running--;
    if (n === 2) throw new Error("two");
  };
  const results = [run(task(1, 20)), run(task(2, 5)), run(task(3, 1))];
  assert.equal(run.size(), 3);
  await assert.rejects(results[1], /two/);
  await run.idle();
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(run.size(), 0);
});

test("stop flushes synchronously and repeated stop does not duplicate audio", () => {
  const r = receiver(),
    got = [];
  const stop = listen(r, { decoder, onUtterance: (u) => got.push(u) });
  r.speak("alice", packet(1));
  stop();
  stop();
  assert.equal(got.length, 1);
  assert.equal(got[0].pcm.length, FRAME);
  assert.equal(r.speaking.listenerCount("start"), 0);
});

test("a pending member lookup cannot attach after stop", async () => {
  const r = receiver();
  let resolve;
  const stop = listen(r, {
    decoder,
    ignore: () =>
      new Promise((done) => {
        resolve = done;
      }),
    onUtterance: () => assert.fail(),
  });
  r.speak("alice", packet(1));
  stop();
  resolve(false);
  await tick();
  assert.equal(r.subscriptions.size, 0);
});

test("restarting before old stream close preserves the new subscription", async () => {
  const r = receiver(),
    got = [];
  const options = { decoder, onUtterance: (u) => got.push(u) };
  const stop = listen(r, options);
  r.speak("alice", packet(1));
  const old = r.subscriptions.get("alice");
  stop();
  const stopAgain = listen(r, options);
  await once(old, "close");
  const fresh = r.subscriptions.get("alice");
  assert.ok(fresh && fresh !== old);
  r.speak("alice", packet(2));
  await r.pause("alice");
  assert.deepEqual(
    got.map((u) => u.pcm[0]),
    [1, 2],
  );
  stopAgain();
});

test("first packet sets the timestamp and decoder buffers are copied", async () => {
  const r = receiver(),
    got = [];
  let now = 1000;
  const pcm = Buffer.alloc(FRAME);
  listen(r, {
    decoder: () => ({ decode: (p) => pcm.fill(p[0]), delete() {} }),
    now: () => now,
    onUtterance: (u) => got.push(u),
  });
  r.speak("alice");
  now = 2000;
  r.speak("alice", packet(1), packet(2));
  await tick();
  now = 3000;
  await r.pause("alice");
  assert.equal(+got[0].startedAt, 2000);
  assert.equal(+got[0].endedAt, 2000);
  assert.equal(got[0].pcm[0], 1);
  assert.equal(got[0].pcm[FRAME], 2);
});

test("one oversized decoded packet still splits at the maximum length", async () => {
  const r = receiver(),
    got = [];
  listen(r, {
    decoder: () => ({ decode: () => Buffer.alloc(FRAME * 5), delete() {} }),
    maxSeconds: 0.04,
    onUtterance: (u) => got.push(u),
  });
  r.speak("alice", packet(1));
  await r.pause("alice");
  assert.deepEqual(
    got.map((u) => u.pcm.length / FRAME),
    [2, 2, 1],
  );
});

test("serial discard aborts an active task, releases idle, and ignores late failure", async () => {
  const run = serial();
  let signal, reject;
  const first = run((s) => {
    signal = s;
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  });
  const second = run(() => assert.fail("discarded task ran"));
  await tick();
  const idle = run.idle();
  assert.equal(run.discard(), 2);
  assert.equal(run.discard(), 0);
  await Promise.all([first, second, idle]);
  assert.ok(signal.aborted);
  reject(new Error("late failure"));
  await tick();
  assert.equal(run.size(), 0);
  assert.equal(await run(() => "recovered"), "recovered");
});
