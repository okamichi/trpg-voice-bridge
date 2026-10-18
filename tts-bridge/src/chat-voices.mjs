import { randomUUID } from "node:crypto";
import {
  canonical,
  check,
  resolveCharacter,
  voiceSchema,
} from "./contracts.mjs";
import { AUDIO_LIMIT } from "./provider.mjs";
import { NEW_VOICE_DEFAULTS, VOICE_CONFIRMATION } from "./voice-defaults.mjs";

export function voiceCommand(text) {
  const trimmed = text.trim();
  for (const [prefix, kind] of [
    ["（ブリッジ声登録）", "register"],
    ["（ブリッジ声削除）", "delete"],
  ]) {
    if (trimmed.startsWith(prefix))
      return { kind, caption: trimmed.slice(prefix.length).trim() };
  }
  return null;
}
const running = (job) =>
  job && ["queued", "generating", "registering"].includes(job.status);

export class ChatVoices {
  constructor(engine) {
    this.engine = engine;
    this.store = engine.store;
    this.records = this.store.voiceCommands;
    this.tasks = new Map();
    this.closed = false;
  }
  changed() {
    this.engine.notify("characters.changed");
  }
  accept(event, key, fingerprint, command) {
    check(!this.closed, "アプリ終了中です", 503);
    const { engine, store, records } = this;
    const job = {
      id: randomUUID(),
      kind: command.kind,
      status: "queued",
      created: Date.now(),
    };
    let character, voice;
    const targeted =
      event.kind === "dialogue" &&
      engine.config.allowedChannels.includes(event.channel) &&
      engine.config.allowedKinds.includes(event.kind);
    if (!targeted || !engine.config.chatVoiceRegistrationEnabled) {
      job.status = "ignored";
      job.reason = targeted
        ? "チャットによる声登録・削除は無効です"
        : "対象外チャネル・種別です";
    } else {
      character = resolveCharacter(store.config, event);
      if (!character && command.kind === "register") {
        try {
          character = store.discover(event).character;
        } catch (error) {
          if (!error.status) throw error;
          job.status = "failed";
          job.reason =
            "キャラを登録できません。登録上限と設定を管理画面で確認してください。";
          job.detail = error.message;
        }
      }
      job.characterId = character?.id;
      if (job.status !== "failed") {
        if (
          !character &&
          command.kind === "delete" &&
          (event.speaker.id || (event.speaker.tokenId && event.speaker.sceneId))
        ) {
          job.status = command.caption ? "failed" : "completed";
          job.reason = command.caption
            ? "声削除コマンドの後には文字を付けないでください"
            : "声は未設定です";
        } else if (!character) {
          job.status = "failed";
          job.reason = "発言キャラを特定できません";
        } else if (command.kind === "register" && records.busy(character.id)) {
          job.status = "rejected";
          job.reason = "処理中のため追加の登録は受け付けませんでした";
        } else {
          try {
            if (command.kind === "delete") {
              check(
                !command.caption,
                "声削除コマンドの後には文字を付けないでください",
              );
              job.status = "completed";
            } else {
              check(
                command.caption,
                "声の説明を入力してもう一度登録してください",
              );
              check(
                character.enabled,
                "キャラが無効です。Playerで有効にしてください",
              );
              check(
                engine.config.provider.type !== "mock",
                "モックでは参照音声を登録できません",
              );
              check(
                !engine.degraded,
                "TTSが不調です。管理画面で確認してください",
              );
              check(
                store.config.voiceProfiles.length < 500,
                "登録上限です。管理画面で確認してください",
              );
              check(
                engine.pendingMessages() < 30,
                "生成キューが満杯です。少し待って再試行してください",
              );
              check(
                engine.audioBytes() +
                  (engine.pendingMessages() + 1) * AUDIO_LIMIT <=
                  engine.maxAudioBytes,
                "音声保管容量が不足しています。少し待って再試行してください",
              );
              const stamp = new Date().toISOString();
              voice = {
                ...NEW_VOICE_DEFAULTS,
                id: randomUUID(),
                name: `${character.displayName.slice(0, 150)}の声 ${stamp} ${job.id.slice(0, 8)}`,
                caption: command.caption,
              };
              voiceSchema(voice);
            }
          } catch (error) {
            if (!error.status) throw error;
            job.status = "failed";
            job.reason = error.message;
          }
        }
      }
    }
    let seq;
    store.change((config) => {
      seq = store.recordInside(key, fingerprint, job.id, job.status);
      if (job.kind === "delete" && job.status === "completed" && character) {
        records.cancel(character.id, "声削除により中断しました", false);
        config.characters.find((c) => c.id === character.id).voiceProfileId =
          null;
      }
      const existing = character && records.states()[character.id];
      const keepRunning =
        existing &&
        records.busy(character.id) &&
        job.status !== "queued" &&
        job.status !== "completed";
      records.write(job, job.status !== "ignored" && !keepRunning);
      if (keepRunning) {
        const current = records.get(existing.operationId);
        if (running(current)) records.write({ ...current, note: job.reason });
      }
    });
    if (job.status !== "ignored") this.changed();
    if (job.kind === "delete" && job.status === "completed" && character) {
      this.reconcile();
      for (const order of engine.orders.values())
        if (
          order.characterId === character.id &&
          ["queued", "synthesizing", "ready"].includes(order.status)
        )
          engine.skip(order);
    }
    if (job.status === "queued") {
      const task = {
        job,
        character: structuredClone(character),
        voice,
        provider: structuredClone(engine.config.provider),
        controller: new AbortController(),
      };
      this.tasks.set(job.id, task);
      task.promise = this.run(task).finally(() => this.tasks.delete(job.id));
      // Shutdown also waits for rejected tasks before closing SQLite.
      task.promise.catch((error) => {
        engine.lastError = error.message;
      });
    }
    return {
      http: job.status === "queued" ? 202 : 200,
      orderId: job.id,
      orderSeq: seq,
      status: job.status,
      ...(job.reason ? { reason: job.reason } : {}),
    };
  }
  valid(task) {
    task.controller.signal.throwIfAborted();
    check(
      !this.closed && running(this.records.get(task.job.id)),
      "登録を中断しました",
      409,
    );
    check(
      this.store.config.chatVoiceRegistrationEnabled &&
        canonical(this.engine.config.provider) === canonical(task.provider),
      "設定変更で中断しました",
      409,
    );
  }
  async run(task) {
    const { engine, records, store } = this;
    let stage = "generate";
    const waitTimer = setTimeout(() => {
      if (records.get(task.job.id)?.status === "queued") {
        records.update(task.job.id, {
          status: "failed",
          reason: "生成待機の期限が切れました。もう一度登録してください。",
        });
        task.controller.abort(new Error("生成待機の期限切れ"));
        this.changed();
      }
    }, 180000);
    waitTimer.unref();
    try {
      const wav = await engine.preview(VOICE_CONFIRMATION, task.voice, {
        registrationId: task.job.id,
        provider: task.provider,
        signal: task.controller.signal,
        onStart: () => {
          clearTimeout(waitTimer);
          this.valid(task);
          records.update(task.job.id, { status: "generating" });
          this.changed();
        },
      });
      this.valid(task);
      const audio = engine.saveAudio(wav);
      stage = "register";
      task.referenceId = `chat-${task.job.id}`;
      records.update(task.job.id, {
        status: "registering",
        referenceId: task.referenceId,
      });
      this.changed();
      await engine.references.register({
        provider: task.provider,
        voiceId: task.referenceId,
        wav,
        wait: true,
        signal: task.controller.signal,
        before: () => {
          this.valid(task);
          check(store.config.voiceProfiles.length < 500, "登録上限です", 409);
        },
      });
      this.valid(task);
      task.voice.voiceId = task.referenceId;
      stage = "save";
      store.change((config) => {
        this.valid(task);
        const current = config.characters.find(
          (c) => c.id === task.character.id,
        );
        check(
          current && current.enabled,
          "キャラが無効または削除済みです",
          409,
        );
        store.compare(current, task.character);
        check(config.voiceProfiles.length < 500, "登録上限です", 409);
        config.voiceProfiles.push(task.voice);
        current.voiceProfileId = task.voice.id;
        records.write({
          ...records.get(task.job.id),
          status: "completed",
          reason: "",
          note: "",
          unplayed: !engine.accepting,
        });
      });
      this.changed();
      stage = "play";
      if (
        !this.closed &&
        engine.accepting &&
        records.get(task.job.id)?.status === "completed"
      )
        engine.publishVoiceConfirmation(task.character, audio);
    } catch (error) {
      const detail = String(error.message).slice(0, 1000);
      if (stage === "play")
        engine.lastError = `声は登録済みですが確認音声を配信できませんでした: ${detail}`;
      else {
        const reason =
          stage === "generate"
            ? "音声を生成できませんでした。TTSの状態を確認して再試行してください。"
            : stage === "register"
              ? "参照音声を登録できませんでした。管理画面で確認してください。"
              : "声の設定を保存できませんでした。管理画面で確認してください。";
        const job = records.update(task.job.id, {
          status: "failed",
          reason,
          detail,
          ...(task.referenceId ? { referenceId: task.referenceId } : {}),
        });
        if (!job && task.referenceId) {
          store.transaction(() => {
            const old = records.get(task.job.id);
            if (old)
              records.write(
                { ...old, referenceId: task.referenceId, detail },
                false,
              );
          });
        }
        this.changed();
      }
    } finally {
      clearTimeout(waitTimer);
    }
  }
  reconcile() {
    for (const task of this.tasks.values()) {
      if (!running(this.records.get(task.job.id)))
        task.controller.abort(new Error("登録を中断しました"));
    }
  }
  cancel(reason) {
    this.store.transaction(() => this.records.cancel(null, reason));
    this.reconcile();
    this.changed();
  }
  shutdown() {
    this.closed = true;
    this.cancel("アプリ終了で中断しました。もう一度登録してください。");
  }
  async drain() {
    await Promise.allSettled([...this.tasks.values()].map((t) => t.promise));
  }
}
