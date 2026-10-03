// One playback pump per page; every async boundary rechecks the generation.
export class Playback {
  constructor({ load, play, stop, now = Date.now, onState = () => {} }) {
    Object.assign(this, { load, play, stop, now, onState });
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
  }
  reset(meta, baseline) {
    this.generation++;
    this.meta = meta;
    this.baseline = baseline;
    this.pending.clear();
    this.cancelled.clear();
    this.started.clear();
    this.loading?.controller.abort();
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
    this.loading?.controller.abort();
    this.stop();
    this.onState("blocked");
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
    this.pump();
  }
  async pump() {
    if (this.running || !this.enabled) return;
    this.running = true;
    try {
      while (this.enabled && this.pending.size) {
        const item = [...this.pending.values()].sort(
          (a, b) => a.orderSeq - b.orderSeq,
        )[0];
        this.pending.delete(item.orderId);
        if (
          item.playBefore < this.now() ||
          this.muted.has(item.characterId) ||
          this.started.has(item.orderId)
        )
          continue;
        const generation = this.generation;
        try {
          const controller = new AbortController();
          this.loading = { orderId: item.orderId, controller };
          this.onState("fetching", item);
          const audio = await this.load(item, controller.signal);
          this.loading = null;
          if (
            generation !== this.generation ||
            this.cancelled.has(item.orderId) ||
            item.playBefore < this.now() ||
            !this.enabled ||
            this.muted.has(item.characterId)
          )
            continue;
          this.started.add(item.orderId);
          this.current = item;
          this.onState("playing", item);
          await this.play(audio, item);
          if (generation === this.generation) {
            this.current = null;
            this.onState("idle", item);
          }
        } catch (e) {
          if (
            generation === this.generation &&
            !this.cancelled.has(item.orderId)
          )
            this.onState("error", e.message);
        } finally {
          this.loading = null;
        }
      }
    } finally {
      this.running = false;
      if (this.enabled && this.pending.size) queueMicrotask(() => this.pump());
    }
  }
}
