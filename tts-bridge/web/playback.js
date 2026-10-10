// One playback pump per page; every async boundary rechecks the generation.
// While one sound plays, the next one is fetched and decoded, so the sentences
// of a long message follow each other after only their configured pause.
export class Playback {
  constructor({
    load,
    play,
    stop,
    now = Date.now,
    onState = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    Object.assign(this, { load, play, stop, now, onState, sleep });
    this.pending = new Map();
    this.started = new Set();
    this.muted = new Set();
    this.enabled = false;
    this.generation = 0;
    this.baseline = 0;
    this.running = false;
    this.current = null;
    this.cancelled = new Set();
    this.loading = null;
    this.manual = null;
    this.prefetched = null;
    this.lastEnded = null;
  }
  dropPrefetch() {
    this.prefetched?.controller.abort();
    this.prefetched = null;
  }
  /** The item the pump would play next, if one is waiting. */
  nextItem() {
    return [...this.pending.values()]
      .sort((a, b) => a.orderSeq - b.orderSeq)
      .find(
        (x) =>
          x.playBefore >= this.now() &&
          !this.muted.has(x.characterId) &&
          !this.started.has(x.orderId) &&
          !this.cancelled.has(x.orderId),
      );
  }
  prefetchNext() {
    const item = this.nextItem();
    if (!item || this.prefetched?.orderId === item.orderId) return;
    this.dropPrefetch();
    const controller = new AbortController(),
      promise = this.load(item, controller.signal);
    promise.catch(() => {});
    this.prefetched = {
      orderId: item.orderId,
      generation: this.generation,
      controller,
      promise,
    };
  }
  fetch(item) {
    const p = this.prefetched;
    if (p?.orderId === item.orderId && p.generation === this.generation) {
      this.prefetched = null;
      this.loading = { orderId: item.orderId, controller: p.controller };
      return p.promise;
    }
    const controller = new AbortController();
    this.loading = { orderId: item.orderId, controller };
    return this.load(item, controller.signal);
  }
  reset(meta, baseline) {
    this.generation++;
    this.meta = meta;
    this.baseline = baseline;
    this.pending.clear();
    this.cancelled.clear();
    this.started.clear();
    this.manual = null;
    this.lastEnded = null;
    this.loading?.controller.abort();
    this.dropPrefetch();
    this.stop();
    this.current = null;
  }
  enable() {
    this.enabled = true;
    this.pump();
  }
  disable() {
    this.enabled = false;
    this.generation++;
    this.pending.clear();
    this.manual = null;
    this.lastEnded = null;
    this.loading?.controller.abort();
    this.dropPrefetch();
    this.stop();
    this.onState("blocked");
  }
  // A listener-requested replay plays on this page only, after the current
  // sound, and ignores mute and the live deadline.
  replay(item) {
    if (
      !this.enabled ||
      this.cancelled.has(item.orderId) ||
      item.sessionId !== this.meta?.sessionId ||
      item.playbackEpoch !== this.meta?.playbackEpoch
    )
      return false;
    this.manual = item;
    this.pump();
    return true;
  }
  accept(n) {
    if (
      n.bootId !== this.meta?.bootId ||
      n.sessionId !== this.meta?.sessionId ||
      n.playbackEpoch !== this.meta?.playbackEpoch
    )
      return;
    if (n.type === "order.skipped") {
      this.pending.delete(n.orderId);
      this.cancelled.add(n.orderId);
      if (this.loading?.orderId === n.orderId) this.loading.controller.abort();
      if (this.prefetched?.orderId === n.orderId) this.dropPrefetch();
      return;
    }
    if (
      n.type !== "audio.ready" ||
      n.orderSeq <= this.baseline ||
      this.started.has(n.orderId) ||
      this.cancelled.has(n.orderId)
    )
      return;
    this.pending.set(n.orderId, n);
    if (this.pending.size > 100) {
      this.pending.clear();
      this.onState("blocked", "発言が溜まっています。最新へ戻ってください");
      return;
    }
    if (this.current) this.prefetchNext();
    this.pump();
  }
  async pump() {
    if (this.running || !this.enabled) return;
    this.running = true;
    try {
      while (this.enabled && (this.manual || this.pending.size)) {
        const manual = !!this.manual;
        const item =
          this.manual ??
          [...this.pending.values()].sort((a, b) => a.orderSeq - b.orderSeq)[0];
        this.manual = null;
        this.pending.delete(item.orderId);
        if (
          !manual &&
          (item.playBefore < this.now() ||
            this.muted.has(item.characterId) ||
            this.started.has(item.orderId))
        )
          continue;
        const generation = this.generation;
        try {
          this.onState("fetching", item);
          const audio = await this.fetch(item);
          this.loading = null;
          // The next sentence of the same message waits its pause, counted
          // from the end of the previous one.
          const wait =
            !manual &&
            item.pauseBeforeMs > 0 &&
            this.lastEnded?.groupId === item.groupId
              ? item.pauseBeforeMs - (this.now() - this.lastEnded.at)
              : 0;
          if (wait > 0) await this.sleep(wait);
          if (
            generation !== this.generation ||
            this.cancelled.has(item.orderId) ||
            !this.enabled ||
            (!manual &&
              (item.playBefore < this.now() ||
                this.muted.has(item.characterId)))
          )
            continue;
          this.started.add(item.orderId);
          this.current = item;
          this.onState("playing", item);
          this.prefetchNext();
          await this.play(audio, item);
          if (generation === this.generation) {
            this.current = null;
            this.lastEnded = { groupId: item.groupId, at: this.now() };
            this.onState("idle", item);
          }
        } catch (e) {
          if (
            generation === this.generation &&
            !this.cancelled.has(item.orderId)
          )
            this.onState("error", e.message, item);
        } finally {
          this.loading = null;
        }
      }
    } finally {
      this.running = false;
      if (this.enabled && (this.manual || this.pending.size))
        queueMicrotask(() => this.pump());
    }
  }
}
