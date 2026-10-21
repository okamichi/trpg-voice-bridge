// HTTP is authoritative for revisions; socket notifications trigger catch-up.
// This avoids using an audio notification sequence as a durable chat cursor.
export class ChatHistory {
  constructor({ client, changed = () => {}, error = () => {} }) {
    Object.assign(this, { client, changed, error });
    this.messages = new Map();
    this.deleted = new Map();
    this.version = 0;
    this.active = false;
    this.initial = true;
    this.cursor = 0;
  }
  state(meta) {
    const generation = meta.chatGeneration ?? meta.chat?.generation;
    const enabled = meta.chatEnabled ?? meta.chat?.enabled;
    if (!generation) return;
    if (this.bootId === meta.bootId && generation < this.generation) return;
    const reset =
      this.roomId !== meta.roomId ||
      this.bootId !== meta.bootId ||
      generation !== this.generation ||
      this.sessionId !== meta.sessionId;
    Object.assign(this, {
      roomId: meta.roomId,
      bootId: meta.bootId,
      sessionId: meta.sessionId,
      generation,
      enabled,
    });
    this.active = true;
    if (reset || !enabled) {
      this.version++;
      this.messages.clear();
      this.deleted.clear();
      this.initial = true;
      this.cursor = 0;
      this.hasMore = false;
      this.changed({ reset: true });
    }
    if (enabled) this.sync();
  }
  stop() {
    this.active = false;
    this.version++;
    this.messages.clear();
    this.changed({ reset: true });
  }
  merge(message) {
    if ((this.deleted.get(message.id) ?? 0) >= message.updated) return;
    const old = this.messages.get(message.id);
    if (!old || old.updated <= message.updated)
      this.messages.set(message.id, message);
  }
  sync() {
    this.dirty = true;
    if (this.running || !this.active || !this.enabled) return;
    this.running = true;
    this.run().finally(() => {
      this.running = false;
      if (this.dirty && this.active && this.enabled) this.sync();
    });
  }
  async run() {
    while (this.dirty && this.active && this.enabled) {
      this.dirty = false;
      const version = this.version;
      try {
        const path = this.initial
          ? "messages"
          : `message-changes?generation=${this.generation}&since=${this.cursor}`;
        const data = await this.client.json(
          this.client.room(this.roomId, path),
        );
        if (version !== this.version || !this.active) continue;
        if (data.generation !== this.generation || data.resetRequired) {
          if (data.generation < this.generation) continue;
          this.generation = data.generation;
          this.enabled = data.enabled;
          this.version++;
          this.messages.clear();
          this.deleted.clear();
          this.initial = true;
          this.changed({ reset: true });
          this.dirty = this.enabled;
          continue;
        }
        const initial = this.initial;
        if (initial) {
          for (const m of data.messages) this.merge(m);
          this.cursor = data.updateSeq;
          this.hasMore = data.hasMore;
          this.initial = false;
          this.dirty = true; // Close the snapshot/subscription race.
        } else {
          for (const change of data.changes) {
            if (change.type === "chat.message.deleted") {
              this.deleted.set(change.messageId, change.updateSeq);
              this.messages.delete(change.messageId);
            } else if (change.message) this.merge(change.message);
          }
          this.cursor = data.nextSince;
          this.dirty ||= data.hasMore;
        }
        this.changed({ initial });
      } catch (error) {
        if (version === this.version && this.active) this.error(error);
        // Retry on the next notification, reconnect, or periodic catch-up.
      }
    }
  }
  trim(limit) {
    const ordered = [...this.messages.values()].sort((a, b) => a.seq - b.seq);
    for (const message of ordered.slice(0, Math.max(0, ordered.length - limit)))
      this.messages.delete(message.id);
  }
  async older() {
    if (!this.hasMore || this.loadingOlder || !this.active || !this.enabled)
      return;
    const version = this.version;
    const before = Math.min(...[...this.messages.values()].map((m) => m.seq));
    this.loadingOlder = true;
    try {
      const data = await this.client.json(
        this.client.room(this.roomId, `messages?before=${before}`),
      );
      if (
        version !== this.version ||
        data.generation !== this.generation ||
        !this.active
      )
        return;
      // A deletion might have arrived while this page was in flight. Reapply
      // all revisions since this response before exposing the older page.
      for (const m of data.messages) this.merge(m);
      this.cursor = Math.min(this.cursor, data.updateSeq);
      this.hasMore = data.hasMore;
      this.changed({ older: true });
      this.sync();
    } catch (error) {
      if (version === this.version) this.error(error);
    } finally {
      this.loadingOlder = false;
    }
  }
}
