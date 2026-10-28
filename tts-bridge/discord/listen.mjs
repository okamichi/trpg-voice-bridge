import { DISCORD_RATE, DISCORD_FRAME_BYTES } from "./pcm.mjs";

// Each Discord member has an independent Opus stream and decoder.
export function listen(
  receiver,
  {
    decoder,
    endBehavior,
    silenceMs = 800,
    maxSeconds = 30,
    ignore = () => false,
    onUtterance,
    onError = () => {},
    now = () => Date.now(),
  },
) {
  const active = new Map(),
    checking = new Set();
  const maxBytes = Math.max(
    4,
    Math.round(maxSeconds * DISCORD_RATE) * DISCORD_FRAME_BYTES,
  );
  let stopped = false;
  const subscribe = (userId, ignored) => {
    checking.delete(userId);
    if (stopped || ignored || active.has(userId)) return;
    const previous = receiver.subscriptions.get(userId);
    if (previous?.destroyed || previous?.readableEnded) {
      // VoiceReceiver deletes its map entry on close unconditionally. Wait
      // before reattaching, otherwise the old close removes the new stream.
      checking.add(userId);
      previous.once("close", () => subscribe(userId, ignored));
      return;
    }
    let stream, opus;
    try {
      opus = decoder();
      stream = receiver.subscribe(userId, {
        end: { behavior: endBehavior, duration: silenceMs },
      });
    } catch (error) {
      opus?.delete();
      onError(error);
      return;
    }
    let chunks = [],
      bytes = 0,
      startedAt,
      endedAt,
      finished = false;
    const flush = () => {
      const pcm = Buffer.concat(chunks, bytes);
      chunks = [];
      bytes = 0;
      if (pcm.length) onUtterance({ userId, startedAt, endedAt, pcm });
    };
    const data = (packet) => {
      if (finished) return;
      let pcm;
      try {
        pcm = opus.decode(packet);
      } catch (error) {
        onError(error);
        return;
      }
      for (let offset = 0; offset < pcm.length;) {
        if (!bytes) startedAt = new Date(now());
        endedAt = new Date(now());
        const length = Math.min(pcm.length - offset, maxBytes - bytes);
        // Opus decoders may reuse their output buffer.
        chunks.push(Buffer.from(pcm.subarray(offset, offset + length)));
        bytes += length;
        offset += length;
        if (bytes === maxBytes) flush();
      }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      stream.off("data", data);
      try {
        opus.delete();
      } catch (error) {
        onError(error);
      }
      flush();
    };
    const stop = () => {
      // Include packets already received but not yet emitted by Readable.
      while (!finished && stream.read() !== null) {
        /* read emits data */
      }
      finish();
      stream.destroy();
    };
    active.set(userId, stop);
    stream.on("data", data);
    stream.once("end", finish);
    stream.on("error", onError);
    stream.once("close", () => {
      finish();
      active.delete(userId);
      if (!stopped && receiver.speaking.users.has(userId)) start(userId);
    });
  };
  const start = (userId) => {
    if (stopped || active.has(userId) || checking.has(userId)) return;
    checking.add(userId);
    try {
      const ignored = ignore(userId);
      if (ignored?.then)
        ignored.then(
          (value) => subscribe(userId, value),
          (error) => {
            checking.delete(userId);
            onError(error);
          },
        );
      else subscribe(userId, ignored);
    } catch (error) {
      checking.delete(userId);
      onError(error);
    }
  };
  receiver.speaking.on("start", start);
  for (const id of receiver.speaking.users.keys()) start(id);
  return () => {
    stopped = true;
    receiver.speaking.off("start", start);
    for (const stop of active.values()) stop();
    active.clear();
  };
}

// A bounded serial queue. Discarding aborts the active request too, including
// a request waiting for TTS priority. Late results cannot resume the queue.
export function serial({ maxPending = Infinity, onDrop = () => {} } = {}) {
  const queue = [];
  let active,
    idleWaiters = [];
  const pump = () => {
    if (active) return;
    const job = queue.shift();
    if (!job) {
      for (const resolve of idleWaiters.splice(0)) resolve();
      return;
    }
    active = job;
    let abort;
    const cancelled = new Promise((resolve) => {
      abort = resolve;
    });
    job.controller.signal.addEventListener("abort", abort, { once: true });
    Promise.race([
      Promise.resolve().then(() =>
        job.controller.signal.aborted
          ? undefined
          : job.task(job.controller.signal),
      ),
      cancelled,
    ])
      .then(job.resolve, job.reject)
      .finally(() => {
        job.controller.signal.removeEventListener("abort", abort);
        if (active === job) active = undefined;
        pump();
      });
  };
  const run = (task) => {
    const result = new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject, controller: new AbortController() });
    });
    if (queue.length > maxPending) {
      queue.shift().resolve();
      onDrop("backlog", 1);
    }
    pump();
    return result;
  };
  run.size = () => queue.length + (active ? 1 : 0);
  run.pending = () => queue.length;
  run.idle = () =>
    run.size()
      ? new Promise((resolve) => idleWaiters.push(resolve))
      : Promise.resolve();
  run.discard = () => {
    const count =
      queue.length + (active && !active.controller.signal.aborted ? 1 : 0);
    for (const job of queue.splice(0)) job.resolve();
    active?.controller.abort();
    return count;
  };
  return run;
}
