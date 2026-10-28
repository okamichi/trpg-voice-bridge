import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { Playback } from "../web/playback.js";
import {
  toDiscordPcm,
  toMono,
  wavFile,
  seconds,
  DISCORD_RATE,
} from "./pcm.mjs";
import { listen, serial } from "./listen.mjs";
import { EchoGuard } from "./echo.mjs";
import { discordRequire } from "./dependencies.mjs";
import { VoiceDesign } from "./voice-design.mjs";

export async function loadDependencies() {
  const discord = discordRequire("discord.js");
  const voice = discordRequire("@discordjs/voice");
  const OpusScript = discordRequire("opusscript");
  return { ...discord, ...voice, OpusScript };
}

// Race a task without leaving timeout handles or unhandled rejections behind.
export async function bounded(task, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createBot({
  engine,
  token,
  deps,
  transcription = null,
  greeting = async () => null,
  greetingText = () => null,
  onError = () => {},
  timeouts = {},
  designSettings = () => ({ enabled: false }),
}) {
  const d = deps ?? (await loadDependencies());
  const limits = {
    login: 30000,
    connect: 30000,
    recover: 5000,
    greeting: 15000,
    leaveDelay: 1500,
    transcription: 10000,
    ...timeouts,
  };
  const client = new d.Client({
    intents: [d.GatewayIntentBits.Guilds, d.GatewayIntentBits.GuildVoiceStates],
  });
  const design = new VoiceDesign({
    client,
    engine,
    settings: designSettings,
    report: onError,
  });
  const player = d.createAudioPlayer();
  let connection,
    subscription,
    accepting = false,
    closed = false,
    finishPlay,
    cancelMessage;
  let state = "logged-out",
    error = "",
    generation = 0,
    recovering,
    recoveryController;
  const lifetime = new AbortController();
  const report = (message) => {
    error = message;
    onError(message);
  };
  const echo = new EchoGuard();
  let stopListening,
    receivingAllowed = false,
    sttError = "",
    failedTranscripts = 0,
    droppedTranscripts = 0;
  const reports = new Map(),
    members = new Map();
  const reportStt = (message) => {
    sttError = message;
    const now = Date.now();
    if (now - (reports.get(message) ?? -Infinity) < 60000) return;
    reports.set(message, now);
    report(message);
  };
  const dropped = (reason, count) => {
    if (!count) return;
    droppedTranscripts += count;
    try {
      transcription.dropped(reason, count);
    } catch {
      reportStt("文字起こしの破棄件数を記録できませんでした");
    }
    reportStt(
      reason === "shutdown"
        ? `終了期限のため文字起こしを${count}件破棄しました`
        : reason === "error"
          ? "音声の文字起こしに失敗しました"
          : "文字起こしの順番待ちが200件を超えたため古い発言を破棄しました",
    );
  };
  const transcripts = serial({ maxPending: 200, onDrop: dropped });
  const member = (guild, userId) => {
    const key = `${guild.id}:${userId}`;
    if (!members.has(key))
      members.set(
        key,
        Promise.resolve()
          .then(() => guild.members.fetch(userId))
          .catch(() => guild.members.cache?.get(userId) ?? null),
      );
    return members.get(key);
  };
  const stopCapture = () => {
    const stop = stopListening;
    stopListening = undefined;
    stop?.();
  };
  const capture = () => {
    if (!transcription) return;
    const ready = transcription.ready();
    if (!ready) {
      stopCapture();
      const count = transcripts.discard();
      if (count) {
        failedTranscripts += count;
        dropped("error", count);
      }
    }
    if (
      closed ||
      !receivingAllowed ||
      !connection ||
      connection.state.status !== d.VoiceConnectionStatus.Ready
    )
      return;
    try {
      if (connection.joinConfig.selfDeaf !== !ready) {
        if (connection.rejoin({ selfDeaf: !ready }) === false)
          throw new Error("rejoin");
      }
      if (!ready || stopListening) return;
      const guild = client.guilds.cache.get(connection.joinConfig.guildId);
      stopListening = listen(connection.receiver, {
        decoder: () =>
          new d.OpusScript(DISCORD_RATE, 2, d.OpusScript.Application.AUDIO),
        endBehavior: d.EndBehaviorType.AfterSilence,
        ignore: (id) =>
          id === client.user.id ||
          (guild.members.cache?.has(id)
            ? !!guild.members.cache.get(id).user.bot
            : member(guild, id).then((m) => !!m?.user.bot)),
        onError: () =>
          reportStt("Discordの音声パケットを受信・デコードできませんでした"),
        onUtterance: ({ userId, startedAt, endedAt, pcm }) => {
          const duration = seconds(pcm);
          if (duration < 0.4) return;
          const readings = echo.snapshot(startedAt, endedAt);
          const mono = toMono(pcm);
          const speaker = member(guild, userId);
          void transcripts(async (signal) => {
            const text = await transcription.transcribe(
              wavFile(mono, DISCORD_RATE),
              { signal },
            );
            if (
              signal.aborted ||
              !text?.trim() ||
              echo.echoes(text, startedAt, endedAt, readings)
            )
              return;
            const who = await speaker;
            if (signal.aborted || who?.user.bot) return;
            await transcription.add({
              time: +startedAt,
              speakerId: userId,
              speakerName: who?.displayName || userId,
              seconds: duration,
              text: text.trim(),
            });
          }).catch(() => {
            failedTranscripts++;
            dropped("error", 1);
          });
        },
      });
    } catch {
      stopCapture();
      reportStt("Discordの音声受信を開始・切り替えできませんでした");
      try {
        connection.rejoin({ selfDeaf: true });
      } catch {
        /* disconnected */
      }
    }
  };
  const unsubscribeStt = transcription?.onChange(capture);
  const stop = () => {
    try {
      player.stop(true);
    } catch {
      report("音声の停止に失敗しました");
    }
    finishPlay?.();
  };
  const play = (pcm, text) =>
    new Promise((resolve, reject) => {
      let resource, reading;
      const done = (failure) => {
        reading?.end();
        reading = undefined;
        player.off(d.AudioPlayerStatus.Idle, idle);
        player.off("error", failed);
        if (finishPlay === done) finishPlay = undefined;
        failure ? reject(failure) : resolve();
      };
      const idle = () => done();
      const failed = (failure) => {
        if (!failure.resource || failure.resource === resource)
          done(new Error("音声再生に失敗しました"));
      };
      finishPlay = done;
      player.on(d.AudioPlayerStatus.Idle, idle);
      player.on("error", failed);
      try {
        resource = d.createAudioResource(Readable.from([pcm]), {
          inputType: d.StreamType.Raw,
        });
        if (transcription && text) reading = echo.playing(text);
        player.play(resource);
      } catch {
        done(new Error("音声再生を開始できませんでした"));
      }
    });
  const playback = new Playback({
    load: async (item, signal) => {
      const file = engine.audioFile(item.audio.id);
      if (!file) throw new Error("音声の保持期限が切れています");
      return toDiscordPcm(await readFile(file, { signal }));
    },
    play: (pcm, item) => play(pcm, engine.orderText?.(item.orderId)),
    stop,
    onState: (status) => {
      if (status === "error") report("音声の読み込み・再生に失敗しました");
    },
  });
  const playerError = () => report("音声再生に失敗しました");
  const clientError = () => report("Discordとの通信でエラーが発生しました");
  player.on("error", playerError);
  client.on("error", clientError);
  const notify = (n) => {
    if (!accepting || closed) return;
    try {
      if (n.type === "playback.reset" || n.type === "session.ended") {
        // session.ended is emitted before Engine installs its new session ID.
        const current = generation;
        cancelMessage?.();
        stop();
        queueMicrotask(() => {
          if (accepting && !closed && generation === current)
            playback.reset(engine.metadata(), engine.store.maxSeq());
        });
      } else if (n.type === "audio.ready" || n.type === "order.skipped")
        playback.accept(n);
    } catch {
      report("読み上げ通知を処理できませんでした");
    }
  };
  engine.on("notification", notify);

  const release = (destroy = true) => {
    receivingAllowed = false;
    stopCapture();
    recoveryController?.abort();
    accepting = false;
    cancelMessage?.();
    generation++;
    playback.disable();
    const old = connection;
    connection = undefined;
    try {
      subscription?.unsubscribe();
    } catch {
      /* already detached */
    }
    subscription = undefined;
    if (old) {
      old.off("stateChange", changed);
      // Retain the non-throwing error listener until the destroyed object is collected.
      try {
        if (destroy && old.state.status !== d.VoiceConnectionStatus.Destroyed)
          old.destroy();
      } catch {
        /* already closed */
      }
    }
  };
  async function recover(current) {
    if (recovering === current) return;
    recovering = current;
    const controller = new AbortController();
    recoveryController = controller;
    const recoverGeneration = generation;
    const signal = AbortSignal.any([
      controller.signal,
      lifetime.signal,
      AbortSignal.timeout(limits.recover),
    ]);
    try {
      await Promise.race([
        d.entersState(current, d.VoiceConnectionStatus.Signalling, signal),
        d.entersState(current, d.VoiceConnectionStatus.Connecting, signal),
        d.entersState(current, d.VoiceConnectionStatus.Ready, signal),
      ]);
      await d.entersState(
        current,
        d.VoiceConnectionStatus.Ready,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(limits.connect)]),
      );
      if (connection === current && !closed && generation === recoverGeneration)
        state = "connected";
    } catch {
      if (
        connection === current &&
        !closed &&
        generation === recoverGeneration
      ) {
        release();
        state = "error";
        report("ボイス接続が切れました。接続し直してください");
      }
    } finally {
      controller.abort();
      if (recovering === current) recovering = undefined;
      if (recoveryController === controller) recoveryController = undefined;
    }
  }
  function changed(_old, next) {
    if (closed || !connection) return;
    if (next.status === d.VoiceConnectionStatus.Disconnected) {
      stopCapture();
      state = "connecting";
      void recover(connection);
    } else if (next.status === d.VoiceConnectionStatus.Destroyed) {
      release();
      state = "error";
      report("ボイス接続が終了しました");
    } else if (next.status === d.VoiceConnectionStatus.Ready) {
      capture();
    } else {
      stopCapture();
    }
  }
  async function message(kind, currentGeneration) {
    let expired = false,
      delayTimer,
      cancel;
    const cancelled = new Promise((resolve) => {
      cancel = () => {
        expired = true;
        clearTimeout(delayTimer);
        resolve();
      };
    });
    cancelMessage = cancel;
    try {
      await bounded(
        () =>
          Promise.race([
            cancelled,
            (async () => {
              const text = greetingText(kind);
              const pcm = await greeting(kind);
              if (
                !expired &&
                pcm?.length &&
                generation === currentGeneration &&
                connection
              ) {
                await play(pcm, text);
                if (
                  kind === "leave" &&
                  !expired &&
                  generation === currentGeneration
                )
                  await new Promise((resolve) => {
                    delayTimer = setTimeout(resolve, limits.leaveDelay);
                  });
              }
            })(),
          ]),
        limits.greeting,
      );
    } catch {
      report("入室・退出メッセージを再生できませんでした");
    } finally {
      expired = true;
      clearTimeout(delayTimer);
      if (cancelMessage === cancel) cancelMessage = undefined;
      if (generation === currentGeneration) stop();
    }
  }
  async function disconnect({ farewell = true, preserve = false } = {}) {
    receivingAllowed = false;
    stopCapture();
    accepting = false;
    cancelMessage?.();
    playback.disable();
    const current = ++generation;
    if (farewell && connection?.state.status === d.VoiceConnectionStatus.Ready)
      await message("leave", current);
    release(!preserve);
    if (!closed) state = client.isReady() ? "logged-in" : "logged-out";
  }
  async function channels() {
    if (!client.isReady()) return [];
    const result = [];
    for (const guild of [...client.guilds.cache.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      // Gateway keeps these caches current, including guilds invited after login.
      const me = guild.members.me;
      for (const channel of [...guild.channels.cache.values()]
        .filter((c) => c.type === d.ChannelType.GuildVoice)
        .sort((a, b) => a.rawPosition - b.rawPosition)) {
        result.push({
          guildId: guild.id,
          guildName: guild.name,
          channelId: channel.id,
          channelName: channel.name,
          canSpeak:
            !!me &&
            !!channel
              .permissionsFor(me)
              ?.has([
                d.PermissionFlagsBits.ViewChannel,
                d.PermissionFlagsBits.Connect,
                d.PermissionFlagsBits.Speak,
              ]),
        });
      }
    }
    return result;
  }
  async function connect(guildId, channelId) {
    if (closed) return;
    if (
      !(await channels()).some(
        (c) => c.guildId === guildId && c.channelId === channelId && c.canSpeak,
      )
    )
      throw new Error("選択したチャンネルに接続・発言できません");
    const previous =
      connection?.joinConfig.guildId === guildId ? connection : undefined;
    await disconnect({ farewell: true, preserve: !!previous });
    if (closed) {
      if (
        previous &&
        previous.state.status !== d.VoiceConnectionStatus.Destroyed
      )
        previous.destroy();
      return;
    }
    const current = ++generation;
    state = "connecting";
    error = "";
    try {
      const guild = client.guilds.cache.get(guildId);
      receivingAllowed = true;
      connection = d.joinVoiceChannel({
        guildId,
        channelId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: !transcription?.ready(),
        selfMute: false,
      });
      if (connection !== previous)
        connection.on("error", () => report("ボイス接続エラーが発生しました"));
      connection.on("stateChange", changed);
      await d.entersState(
        connection,
        d.VoiceConnectionStatus.Ready,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(limits.connect)]),
      );
      if (closed || current !== generation) return;
      subscription = connection.subscribe(player);
      if (!subscription) throw new Error("購読失敗");
      playback.reset(engine.metadata(), engine.store.maxSeq());
      accepting = true;
      state = "connected";
      capture();
      await message("enter", current);
      if (!closed && accepting && current === generation) playback.enable();
    } catch {
      release();
      if (
        previous &&
        previous.state.status !== d.VoiceConnectionStatus.Destroyed
      )
        previous.destroy();
      if (!closed) {
        state = "error";
        report(
          "ボイス接続に失敗しました。権限とネットワークを確認してください",
        );
      }
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    unsubscribeStt?.();
    stopCapture();
    design.close();
    lifetime.abort();
    let drainTimer;
    try {
      drainTimer = setTimeout(
        () => dropped("shutdown", transcripts.discard()),
        limits.transcription,
      );
      await transcripts.idle();
    } finally {
      clearTimeout(drainTimer);
    }
    await disconnect({ farewell: true });
    engine.off("notification", notify);
    stop();
    player.off("error", playerError);
    try {
      await client.destroy();
    } catch {
      report("Botのログアウトに失敗しました");
    }
    state = "logged-out";
  }
  let cleanupLogin = () => {};
  try {
    await bounded(async () => {
      await new Promise((resolve, reject) => {
        const ready = () => {
          client.off("error", failed);
          resolve();
        };
        const failed = () => {
          client.off(d.Events.ClientReady, ready);
          reject(new Error("login"));
        };
        cleanupLogin = () => {
          client.off(d.Events.ClientReady, ready);
          client.off("error", failed);
        };
        client.once(d.Events.ClientReady, ready);
        client.once("error", failed);
        client.login(token).catch(failed);
      });
    }, limits.login);
    state = "logged-in";
  } catch {
    cleanupLogin();
    await close();
    throw new Error(
      "Botにログインできません。トークンとネットワークを確認してください",
    );
  }
  cleanupLogin();
  return {
    designVoice: (task, valid) => design.open(task, valid),
    cancelDesigns: () => design.cancel(),
    textChannels: async () => {
      const result = [];
      for (const guild of client.guilds.cache.values()) {
        const me = guild.members.me;
        for (const channel of guild.channels.cache.values()) {
          if (channel.type !== 0) continue;
          result.push({
            guildId: guild.id,
            guildName: guild.name,
            channelId: channel.id,
            channelName: channel.name,
            canSend:
              !!me &&
              !!channel
                .permissionsFor(me)
                ?.has([
                  d.PermissionFlagsBits.ViewChannel,
                  d.PermissionFlagsBits.SendMessages,
                  d.PermissionFlagsBits.AttachFiles,
                  d.PermissionFlagsBits.ReadMessageHistory,
                ]),
          });
        }
      }
      return result;
    },
    connect,
    disconnect,
    close,
    channels,
    status: () => ({
      state,
      error,
      transcription: {
        enabled: !!transcription,
        ready: !!transcription?.ready(),
        count: 0,
        ...transcription?.snapshot?.(),
        error: transcription?.snapshot?.().error || sttError,
        pending: transcripts.pending(),
        dropped: droppedTranscripts,
        failed: failedTranscripts,
      },
      botName: client.user?.tag ?? "",
      inviteUrl: client.user
        ? `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=3247104`
        : "",
    }),
  };
}
