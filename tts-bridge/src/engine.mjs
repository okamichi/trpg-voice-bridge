import { ChatVoices, voiceCommand } from "./chat-voices.mjs";
import { ReferenceVoices } from "./reference-voices.mjs";
import { VOICE_CONFIRMATION } from "./voice-defaults.mjs";
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
  participantMessageSchema,
} from "./contracts.mjs";
import { synthesize, inspectWav, AUDIO_LIMIT } from "./provider.mjs";
import { splitLongUtterance } from "./sentences.mjs";
export const DEFAULT_SENTENCE_PAUSE_MS = 900;
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
    this.references = new ReferenceVoices((...args) =>
      (this.options.fetchImpl ?? fetch)(...args),
    );
    this.chatVoices = new ChatVoices(this);
    this.store.chat.recover();
    this.timer = setInterval(() => this.prune(), 30000);
    this.timer.unref();
  }
  get config() {
    return this.options.resolveProvider
      ? {
          ...this.store.config,
          provider: this.options.resolveProvider(this.store.config.provider),
        }
      : this.store.config;
  }
  metadata() {
    return {
      protocolVersion: 1,
      bootId: this.bootId,
      sessionId: this.sessionId,
      roomId: this.config.roomId,
      playbackEpoch: this.playbackEpoch,
      notificationSeq: this.notificationSeq,
      chatGeneration: this.store.chat.metadata().generation,
      chatEnabled: this.config.publishTextToPlayers,
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
      chat: this.store.chat.metadata(),
      orders: [...this.orders.values()]
        .filter((o) => o.epoch === this.playbackEpoch)
        .map((o) => ({
          ...this.publicOrder(o),
          ...(this.config.publishTextToPlayers &&
          o.status === "ready" &&
          o.displayText
            ? { text: o.displayText }
            : {}),
        })),
    };
  }
  publicOrder(o) {
    return {
      orderId: o.orderId,
      orderSeq: o.orderSeq,
      playbackEpoch: o.epoch,
      status: o.status,
      characterId: o.characterId,
      speakerName: o.speakerName,
      error: o.error,
      ...(o.chatTextCleared ? { chatDeleted: true } : {}),
      ...(o.chatMessageId
        ? {
            messageId: o.chatMessageId,
            chatDeleted:
              o.chatTextCleared || !this.store.chat.get(o.chatMessageId),
          }
        : {}),
      ...(o.parts > 1
        ? {
            groupId: o.groupId,
            part: o.part,
            parts: o.parts,
            pauseBeforeMs: o.pauseBeforeMs,
          }
        : {}),
      ...o.ready,
    };
  }
  /** Messages waiting or generating; the sentences of one message count once. */
  pendingMessages() {
    const work = this.working ? [this.working, ...this.queue] : this.queue;
    return (
      new Set(
        work
          .filter((o) => !o.registrationId)
          .map((o) => (o.preview ? o : (o.groupId ?? o.orderId))),
      ).size + this.chatVoices.tasks.size
    );
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
    const chatPrior = this.store.chat.lookup(key, fingerprint);
    if (chatPrior) return { ...chatPrior, http: 200 };
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
    this.consumeInput();
    const command = voiceCommand(e.text);
    if (command) return this.chatVoices.accept(e, key, fingerprint, command);
    if (
      !this.config.allowedChannels.includes(e.channel) ||
      !this.config.allowedKinds.includes(e.kind)
    )
      return { http: 200, status: "ignored", reason: "対象外チャネル・種別" };
    const { character: ch, created } = this.store.discover(e);
    if (created) this.notify("characters.changed");
    return this.acceptChat(
      key,
      fingerprint,
      {
        sessionId: this.sessionId,
        characterId: ch?.id ?? null,
        speakerName: ch?.displayName ?? e.speaker.name,
        text: e.text,
        source: "Collector",
        sourceMessage: e.source,
      },
      ch,
    );
  }
  consumeInput() {
    const now = Date.now();
    this.rate.tokens = Math.min(
      30,
      this.rate.tokens + (now - this.rate.updated) / 100,
    );
    this.rate.updated = now;
    check(this.rate.tokens >= 1, "入力頻度が高すぎます", 429);
    this.rate.tokens--;
  }
  participantMessage(input, participant) {
    check(
      this.config.publishTextToPlayers,
      "チャットと本文の共有は停止中です",
      403,
    );
    check(
      input?.sessionId === this.sessionId,
      "セッションが失効しています",
      409,
    );
    participantMessageSchema(input);
    const key = canonical([
      "participant",
      this.config.roomId,
      participant.id,
      input.clientMessageId,
    ]);
    const fingerprint = createHmac("sha256", this.store.secrets.hmac)
      .update(
        canonical({
          characterId: input.characterId,
          text: input.text,
          sessionId: input.sessionId,
        }),
      )
      .digest("hex");
    const prior = this.store.chat.lookup(key, fingerprint);
    if (prior) return { ...prior, http: 200 };
    const ch = this.config.characters.find((c) => c.id === input.characterId);
    check(ch, "この卓のキャラが見つかりません", 404);
    this.consumeInput();
    return this.acceptChat(
      key,
      fingerprint,
      {
        sessionId: this.sessionId,
        participantId: participant.id,
        clientMessageId: input.clientMessageId,
        characterId: ch.id,
        speakerName: ch.displayName,
        text: input.text,
        source: participant.kind === "chatter" ? "Chatter" : "Player",
      },
      ch,
    );
  }
  acceptChat(key, fingerprint, data, ch) {
    const result = this.store.chat.accept(key, fingerprint, data);
    if (result.duplicate) return { ...result, http: 200 };
    this.notify(result.change.type, result.change);
    let audioResult;
    try {
      audioResult = this.queueSpeech(
        data.text,
        ch,
        key,
        fingerprint,
        result.messageId,
      );
      if (audioResult.status === "ignored")
        this.updateChat(result.messageId, {
          audioStatus: "ignored",
          audioReason: audioResult.reason,
        });
    } catch (error) {
      // The message has committed. TTS failures must not make clients resend it.
      for (const o of this.orders.values())
        if (o.chatMessageId === result.messageId && o.status === "queued")
          this.skip(o, "failed", error.message);
      this.updateChat(result.messageId, {
        audioStatus: "failed",
        audioReason: error.message,
      });
      audioResult = { status: "failed", reason: error.message };
    }
    delete result.change;
    for (const change of this.store.chat.prune(this.sessionId))
      this.notify(change.type, change);
    const response = {
      ...result,
      ...audioResult,
      http:
        data.source === "Collector"
          ? audioResult.status === "queued"
            ? 202
            : 200
          : 201,
    };
    this.store.chat.completeReceipt(key, response);
    return response;
  }
  chatPolicyChanged(clear = false) {
    // Never replay notifications containing bodies from a previous generation.
    this.history = [];
    if (clear)
      for (const o of this.orders.values()) {
        o.chatTextCleared = true;
        delete o.displayText;
        if (!["queued", "synthesizing"].includes(o.status)) delete o.text;
      }
    this.notify("chat.reset", { chat: this.store.chat.metadata() });
  }
  updateChat(messageId, fields) {
    const change = this.store.chat.update(messageId, fields);
    if (change) this.notify(change.type, change);
  }
  updateChatAudio(messageId) {
    if (!messageId) return;
    const orders = [...this.orders.values()].filter(
      (o) => o.chatMessageId === messageId && !o.reuseAudioId,
    );
    if (!orders.length) return;
    const statuses = orders.map((o) => o.status);
    const status =
      ["failed", "cancelled", "expired", "synthesizing", "queued"].find((s) =>
        statuses.includes(s),
      ) ?? "ready";
    this.updateChat(messageId, {
      audioStatus: status,
      audioOrders: orders.map((o) => this.publicOrder(o)),
      audioReason: orders.find((o) => o.error)?.error ?? null,
    });
  }
  queueSpeech(text, ch, key, fingerprint, chatMessageId) {
    const enabled = this.accepting && ch?.enabled && ch.voiceProfileId;
    const orderId = randomUUID(),
      status = enabled ? "queued" : "ignored";
    if (enabled) {
      check(!this.degraded, "TTSが不調です。管理画面で確認してください", 503);
      check(this.pendingMessages() < 30, "生成キューが満杯です", 429);
      this.prune();
      check(
        this.audioBytes() + (this.pendingMessages() + 1) * AUDIO_LIMIT <=
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
    let parts;
    try {
      parts = splitLongUtterance(text, this.config.sentenceSplitThresholdChars);
    } catch {
      parts = [{ text, display: text.trim() }];
    }
    const voice = this.config.voiceProfiles.find(
        (v) => v.id === ch.voiceProfileId,
      ),
      pause = this.config.sentencePauseMs ?? DEFAULT_SENTENCE_PAUSE_MS,
      createdAt = Date.now();
    // Each sentence is its own order, so the first one plays while the rest are made.
    parts.forEach((p, part) => {
      const id = part ? randomUUID() : orderId,
        seq = part
          ? this.store.record(
              canonical(["part", key, part]),
              fingerprint,
              id,
              status,
            )
          : orderSeq,
        o = {
          orderId: id,
          chatMessageId,
          orderSeq: seq,
          status,
          characterId: ch.id,
          speakerName: ch.displayName,
          text: p.text,
          displayText: p.display,
          created: createdAt,
          epoch: this.playbackEpoch,
          voice: structuredClone(voice),
          provider: structuredClone(this.config.provider),
          deliveryCaptionMode: this.config.deliveryCaptionMode ?? "append",
          groupId: orderId,
          part,
          parts: parts.length,
          pauseBeforeMs: part ? pause : 0,
        };
      this.orders.set(id, o);
      this.queue.push(o);
    });
    this.updateChatAudio(chatMessageId);
    this.pump();
    return {
      http: 202,
      orderId,
      orderSeq,
      status: "queued",
      ...(parts.length > 1 ? { parts: parts.length } : {}),
    };
  }
  replay(orderId) {
    check(
      !this.degraded && this.pendingMessages() < 30,
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
  publishVoiceConfirmation(character, audio) {
    const orderId = randomUUID();
    const orderSeq = this.store.record(
      canonical(["voice-confirmation", this.sessionId, orderId]),
      hash(audio.id),
      orderId,
      "ready",
    );
    const now = Date.now();
    const order = {
      orderId,
      orderSeq,
      characterId: character.id,
      speakerName: character.displayName,
      status: "ready",
      created: now,
      epoch: this.playbackEpoch,
      text: VOICE_CONFIRMATION,
      displayText: VOICE_CONFIRMATION,
      ready: {
        audio: {
          id: audio.id,
          url: `/api/v1/rooms/${this.config.roomId}/audio/${audio.id}`,
          bytes: audio.bytes,
          durationMs: audio.durationMs,
          mediaType: audio.mediaType,
        },
        readyAt: now,
        playBefore: now + 120000,
        retainUntil: audio.retainUntil,
      },
    };
    this.orders.set(orderId, order);
    this.notify("audio.ready", {
      ...this.publicOrder(order),
      ...(this.config.publishTextToPlayers ? { text: VOICE_CONFIRMATION } : {}),
    });
  }
  setStatus(o, status, error) {
    o.status = status;
    o.error = error;
    if (o.chatTextCleared && !["queued", "synthesizing"].includes(status)) {
      delete o.text;
      delete o.displayText;
    }
    this.store.status(o.orderId, status);
    this.updateChatAudio(o.chatMessageId);
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
    delete o.displayText;
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
  audioFile(audioId) {
    const audio = this.audio.get(audioId);
    return audio && audio.retainUntil > Date.now() ? audio.file : null;
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
    this.working = o;
    try {
      if (o.preview) {
        o.signal?.throwIfAborted();
        o.onStart?.();
        if (Date.now() - o.created > 180000)
          throw new Error("試聴待機の期限切れ");
        const wav = await synthesize(o.text, o.voice, o.provider, {
          ...this.options,
          signal: o.signal,
          deliveryCaptionMode: o.deliveryCaptionMode,
        });
        inspectWav(wav);
        this.lastError = null;
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
        const wav = await synthesize(o.text, o.voice, o.provider, {
          ...this.options,
          deliveryCaptionMode: o.deliveryCaptionMode,
        });
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
      this.lastError = null;
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
        ...(this.config.publishTextToPlayers && !o.chatTextCleared
          ? { text: o.displayText ?? o.text }
          : {}),
      });
      // Chat text is durable; audio order text remains only for the audio lifetime.
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
      this.working = null;
      if (!this.closed) queueMicrotask(() => this.pump());
    }
  }
  preview(text, voice, options = {}) {
    check(
      typeof text === "string" && text.trim() && [...text].length <= 500,
      "試聴は500文字以内です",
    );
    check(!this.degraded, "TTS不調を確認してください", 503);
    check(
      this.pendingMessages() < 30 ||
        (options.registrationId && this.pendingMessages() === 30),
      "生成キューが満杯です",
      429,
    );
    check(!this.closed, "アプリ終了中です", 503);
    return new Promise((resolve, reject) => {
      const entry = {
        preview: true,
        text,
        voice,
        provider: structuredClone(options.provider ?? this.config.provider),
        deliveryCaptionMode: this.config.deliveryCaptionMode ?? "append",
        created: Date.now(),
        registrationId: options.registrationId,
        signal: options.signal,
        onStart: options.onStart,
      };
      const cancelled = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        entry.reject(options.signal.reason);
      };
      const cleanup = () =>
        options.signal?.removeEventListener("abort", cancelled);
      entry.resolve = (value) => {
        cleanup();
        resolve(value);
      };
      entry.reject = (error) => {
        cleanup();
        reject(error);
      };
      this.queue.push(entry);
      options.signal?.addEventListener("abort", cancelled, { once: true });
      if (options.signal?.aborted) cancelled();
      this.pump();
    });
  }
  reset(
    end = false,
    reason = end
      ? "セッション終了で中断しました"
      : "読み上げ停止で中断しました",
  ) {
    this.chatVoices.cancel(reason);
    this.accepting = false;
    this.playbackEpoch++;
    for (const o of this.orders.values())
      if (["queued", "synthesizing", "ready"].includes(o.status)) {
        this.setStatus(o, "cancelled");
        delete o.text;
        delete o.displayText;
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
        for (const o of this.orders.values())
          if (o.ready?.audio.id === id && o.status === "ready")
            this.setStatus(o, "expired");
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
    for (const change of this.store.chat.prune(this.sessionId))
      this.notify(change.type, change);
  }
  close() {
    this.chatVoices.shutdown();
    this.closed = true;
    clearInterval(this.timer);
    this.reset(false, "アプリ終了で中断しました");
  }
}
