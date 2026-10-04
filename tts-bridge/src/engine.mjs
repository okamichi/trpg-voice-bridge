import { EventEmitter } from "node:events";
import { randomUUID, createHmac } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import {
  canonical,
  check,
  hash,
  eventSchema,
  eventKey,
  sourceKey,
} from "./contracts.mjs";
import { synthesize, inspectWav, AUDIO_LIMIT } from "./provider.mjs";
export class Engine extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.options = options;
    this.bootId = randomUUID();
    this.sessionId = randomUUID();
    this.playbackEpoch = 1;
    this.notificationSeq = 0;
    this.accepting = false;
    this.orders = new Map();
    this.audio = new Map();
    this.collectors = new Map();
    this.history = [];
    this.queue = [];
    this.busy = false;
    this.degraded = false;
    this.lastError = null;
    this.closed = false;
    this.rate = { tokens: 30, updated: Date.now() };
    this.maxAudioBytes = options.maxAudioBytes ?? 512 * 1024 * 1024;
    this.audioDir = join(store.dir, "audio");
    mkdirSync(this.audioDir, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(this.audioDir))
      if (/^[\w-]+\.(wav|tmp)$/.test(f)) unlinkSync(join(this.audioDir, f));
    this.timer = setInterval(() => this.prune(), 30000);
    this.timer.unref();
  }
  get config() {
    return this.store.config;
  }
  metadata() {
    return {
      protocolVersion: 1,
      bootId: this.bootId,
      sessionId: this.sessionId,
      roomId: this.config.roomId,
      playbackEpoch: this.playbackEpoch,
      notificationSeq: this.notificationSeq,
    };
  }
  notify(type, fields = {}) {
    const msg = {
      ...this.metadata(),
      type,
      ...fields,
      notificationSeq: ++this.notificationSeq,
    };
    this.history.push({ ...msg, time: Date.now() });
    this.history = this.history
      .filter((x) => x.time > Date.now() - 600000)
      .slice(-2000);
    this.emit("notification", msg);
    return msg;
  }
  snapshot() {
    return {
      ...this.metadata(),
      type: "state.snapshot",
      serverTime: Date.now(),
      baseline: this.store.maxSeq(),
      accepting: this.accepting,
      orders: [...this.orders.values()]
        .filter((o) => o.epoch === this.playbackEpoch)
        .map((o) => this.publicOrder(o)),
    };
  }
  publicOrder(o) {
    return {
      orderId: o.orderId,
      orderSeq: o.orderSeq,
      status: o.status,
      characterId: o.characterId,
      speakerName: o.speakerName,
      error: o.error,
      ...o.ready,
    };
  }
  connect(body) {
    check(body?.source && typeof body.source === "object", "入力元が必要です");
    check(
      this.config.sources.some((s) => sourceKey(s) === sourceKey(body.source)),
      "入力元が未登録です。拡張から再接続してください",
      403,
    );
    check(
      typeof body.collectorId === "string" &&
        /^[\w-]{1,100}$/.test(body.collectorId),
      "Collector IDが不正です",
    );
    const key = sourceKey(body.source),
      old = this.collectors.get(key);
    check(
      !old ||
        old.collectorId === body.collectorId ||
        Date.now() - old.seen > 60000,
      "別タブのCollectorが接続中です",
      409,
    );
    this.collectors.set(key, {
      collectorId: body.collectorId,
      source: body.source,
      seen: Date.now(),
      diagnostic:
        typeof body.diagnostic === "string"
          ? body.diagnostic.slice(0, 300)
          : "",
    });
    return { ...this.metadata(), accepting: this.accepting };
  }
  ingress(e, collectorId) {
    eventSchema(e);
    check(
      e.roomId === this.config.roomId && e.sessionId === this.sessionId,
      "卓またはセッションが失効しています",
      409,
    );
    const collector = this.collectors.get(sourceKey(e.source));
    check(
      collector?.collectorId === collectorId &&
        Date.now() - collector.seen < 60000 &&
        this.config.sources.some((s) => sourceKey(s) === sourceKey(e.source)),
      "指定Collectorではありません",
      403,
    );
    const key = eventKey(e),
      normalized = {
        source: e.source,
        speaker: e.speaker,
        channel: e.channel,
        visibility: e.visibility,
        kind: e.kind,
        text: e.text,
        occurredAt: e.occurredAt,
      };
    const fingerprint = createHmac("sha256", this.store.secrets.hmac)
      .update(canonical(normalized))
      .digest("hex");
    const prior = this.store.lookup(key);
    if (prior) {
      check(
        prior.fingerprint === fingerprint,
        "同じ発言IDの内容が異なります",
        409,
      );
      return {
        http: 200,
        duplicate: true,
        orderId: prior.orderId,
        orderSeq: prior.seq,
        status: prior.status,
      };
    }
    const now = Date.now();
    this.rate.tokens = Math.min(
      30,
      this.rate.tokens + (now - this.rate.updated) / 100,
    );
    this.rate.updated = now;
    check(this.rate.tokens >= 1, "入力頻度が高すぎます", 429);
    this.rate.tokens--;
    if (
      !this.config.allowedChannels.includes(e.channel) ||
      !this.config.allowedKinds.includes(e.kind)
    )
      return { http: 200, status: "ignored", reason: "対象外チャネル・種別" };
    const { character: ch, created } = this.store.discover(e);
    if (created) this.notify("characters.changed");
    const enabled = this.accepting && ch?.enabled && ch.voiceProfileId;
    const orderId = randomUUID(),
      status = enabled ? "queued" : "ignored";
    if (enabled) {
      check(!this.degraded, "TTSが不調です。管理画面で確認してください", 503);
      check(
        this.queue.length + Number(this.busy) < 30,
        "生成キューが満杯です",
        429,
      );
      this.prune();
      check(
        this.audioBytes() + (this.queue.length + 1) * AUDIO_LIMIT <=
          this.maxAudioBytes,
        "音声保管容量が不足しています",
        429,
      );
    }
    const orderSeq = this.store.record(key, fingerprint, orderId, status);
    if (!enabled)
      return {
        http: 200,
        orderId,
        orderSeq,
        status,
        reason: !this.accepting
          ? "読み上げ停止中"
          : "声が未設定またはキャラ無効",
      };
    const o = {
      orderId,
      orderSeq,
      status,
      characterId: ch.id,
      speakerName: ch.displayName,
      text: e.text,
      created: Date.now(),
      epoch: this.playbackEpoch,
      voice: structuredClone(
        this.config.voiceProfiles.find((v) => v.id === ch.voiceProfileId),
      ),
      provider: structuredClone(this.config.provider),
    };
    this.orders.set(orderId, o);
    this.queue.push(o);
    this.pump();
    return { http: 202, orderId, orderSeq, status: "queued" };
  }
  replay(orderId) {
    check(
      !this.degraded && this.queue.length + Number(this.busy) < 30,
      "生成キューが利用できません",
      429,
    );
    const old = this.orders.get(orderId),
      a = this.audio.get(old?.ready?.audio.id);
    check(
      old?.status === "ready" && a && a.retainUntil > Date.now(),
      "再生できる音声が残っていません",
      409,
    );
    check(
      this.config.characters.some((c) => c.id === old.characterId && c.enabled),
      "キャラは無効または削除済みです",
      409,
    );
    const id = randomUUID(),
      seq = this.store.record(
        canonical(["replay", this.sessionId, id]),
        hash(orderId),
        id,
        "queued",
      ),
      now = Date.now();
    a.retainUntil = Math.max(a.retainUntil, now + 600000);
    const order = {
      ...old,
      orderId: id,
      orderSeq: seq,
      epoch: this.playbackEpoch,
      created: now,
      status: "queued",
      reuseAudioId: a.id,
    };
    delete order.ready;
    this.orders.set(id, order);
    this.queue.push(order);
    this.pump();
    return this.publicOrder(order);
  }
  setStatus(o, status, error) {
    o.status = status;
    o.error = error;
    this.store.status(o.orderId, status);
  }
  skip(o, status = "cancelled", error) {
    if (
      o.status === "cancelled" ||
      o.status === "failed" ||
      o.status === "expired"
    )
      return;
    this.setStatus(o, status, error);
    delete o.text;
    this.notify("order.skipped", {
      orderId: o.orderId,
      orderSeq: o.orderSeq,
      characterId: o.characterId,
      status,
      reason: error ?? status,
    });
  }
  audioBytes() {
    return [...this.audio.values()].reduce((s, a) => s + a.bytes, 0);
  }
  saveAudio(wav) {
    const info = inspectWav(wav);
    check(
      this.audioBytes() + wav.length <= this.maxAudioBytes,
      "音声保管容量不足",
      429,
    );
    const audioId = randomUUID(),
      file = join(this.audioDir, `${audioId}.wav`),
      tmp = join(this.audioDir, `${audioId}.tmp`);
    writeFileSync(tmp, wav, { mode: 0o600 });
    renameSync(tmp, file);
    const a = {
      id: audioId,
      file,
      bytes: wav.length,
      ...info,
      retainUntil: Date.now() + 600000,
    };
    this.audio.set(audioId, a);
    return a;
  }
  async pump() {
    if (this.busy || this.closed || this.degraded) return;
    const o = this.queue.shift();
    if (!o) return;
    this.busy = true;
    try {
      if (o.preview) {
        if (Date.now() - o.created > 180000)
          throw new Error("試聴待機の期限切れ");
        const wav = await synthesize(o.text, o.voice, o.provider, this.options);
        inspectWav(wav);
        o.resolve(wav);
        return;
      }
      if (o.epoch !== this.playbackEpoch || o.status !== "queued") return;
      if (Date.now() - o.created > 180000) {
        this.skip(o, "expired");
        return;
      }
      this.setStatus(o, "synthesizing");
      let a = this.audio.get(o.reuseAudioId);
      check(!o.reuseAudioId || a, "再生音声が期限切れです", 409);
      if (!a) {
        const start = performance.now();
        const wav = await synthesize(o.text, o.voice, o.provider, this.options);
        o.generationMs = performance.now() - start;
        if (
          this.closed ||
          o.epoch !== this.playbackEpoch ||
          o.status !== "synthesizing"
        )
          return;
        a = this.saveAudio(wav);
      }
      if (o.epoch !== this.playbackEpoch || o.status !== "synthesizing") return;
      const now = Date.now();
      a.retainUntil = Math.max(a.retainUntil, now + 600000);
      o.ready = {
        audio: {
          id: a.id,
          url: `/api/v1/rooms/${this.config.roomId}/audio/${a.id}`,
          bytes: a.bytes,
          durationMs: a.durationMs,
          mediaType: a.mediaType,
        },
        readyAt: now,
        playBefore: now + 120000,
        retainUntil: a.retainUntil,
      };
      this.setStatus(o, "ready");
      this.notify("audio.ready", {
        ...this.publicOrder(o),
        ...(this.config.publishTextToPlayers ? { text: o.text } : {}),
      });
      delete o.text;
    } catch (e) {
      const timeout = e.name === "TimeoutError";
      this.lastError = timeout
        ? "生成タイムアウト。上流の処理完了を確認してください"
        : e.message;
      if (timeout) this.degraded = true;
      if (o.preview) o.reject(e);
      else if (o.status === "synthesizing" || o.status === "queued")
        this.skip(o, "failed", this.lastError);
    } finally {
      this.busy = false;
      if (!this.closed) queueMicrotask(() => this.pump());
    }
  }
  preview(text, voice) {
    check(
      typeof text === "string" && text.trim() && [...text].length <= 500,
      "試聴は500文字以内です",
    );
    check(!this.degraded, "TTS不調を確認してください", 503);
    check(this.queue.length < 30, "生成キューが満杯です", 429);
    return new Promise((resolve, reject) => {
      this.queue.push({
        preview: true,
        text,
        voice,
        provider: structuredClone(this.config.provider),
        created: Date.now(),
        resolve,
        reject,
      });
      this.pump();
    });
  }
  reset(end = false) {
    this.accepting = false;
    this.playbackEpoch++;
    for (const o of this.orders.values())
      if (["queued", "synthesizing", "ready"].includes(o.status)) {
        this.setStatus(o, "cancelled");
        delete o.text;
      }
    for (const o of this.queue)
      if (o.preview) o.reject(new Error("全停止しました"));
    this.queue = [];
    this.history = [];
    this.notify(end ? "session.ended" : "playback.reset", {
      baseline: this.store.maxSeq(),
    });
    if (end) {
      this.sessionId = randomUUID();
      this.collectors.clear();
      this.history = [];
      this.notificationSeq = 0;
    }
  }
  configChanged(previous) {
    this.notify("characters.changed");
    for (const ch of previous.characters) {
      const current = this.config.characters.find((x) => x.id === ch.id);
      if (!current || !current.enabled)
        for (const o of this.orders.values())
          if (
            o.characterId === ch.id &&
            ["queued", "synthesizing", "ready"].includes(o.status)
          )
            this.skip(o);
    }
  }
  prune() {
    const now = Date.now();
    for (const [id, a] of this.audio)
      if (a.retainUntil < now) {
        try {
          unlinkSync(a.file);
        } catch {}
        this.audio.delete(id);
      }
    for (const [id, o] of this.orders)
      if (
        !["queued", "synthesizing"].includes(o.status) &&
        (o.ready?.retainUntil ?? o.created + 600000) < now
      )
        this.orders.delete(id);
    this.store.prune();
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.reset();
  }
}
