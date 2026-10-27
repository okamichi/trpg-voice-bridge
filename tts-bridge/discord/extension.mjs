import { dependenciesInstalled } from "./dependencies.mjs";
export { dependenciesInstalled } from "./dependencies.mjs";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createBot } from "./bot.mjs";
import { toDiscordPcm } from "./pcm.mjs";

const fail = (message, status = 422) => {
  throw Object.assign(new Error(message), { status });
};
const check = (ok, message) => {
  if (!ok) fail(message);
};
const defaultGreeting = {
  enterText: "声の準備が整いました。さあ、あなたの物語に、声をつけよう！",
  leaveText: "物語の続きは、また次回。お疲れさまでした！",
  voiceProfileId: "",
};
const defaultVoice = {
  id: "discord-narrator",
  provider: "irodori-local",
  name: "標準のナレーター",
  voiceId: "none",
  caption: "聞き取りやすい若い女性ナレーターの声",
  seed: "1",
  steps: 20,
  speed: 1,
};

export function createExtension({
  engine,
  dataDir,
  transcription = null,
  botFactory = createBot,
  installed = dependenciesInstalled(),
  log = (message) => console.error(`[Discord] ${message}`),
}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "discord.json");
  let settings = {
    enabled: false,
    token: "",
    guildId: "",
    channelId: "",
    autoConnect: false,
    greeting: { ...defaultGreeting },
    hashes: {},
    design: { enabled: false, guildId: "", channelId: "" },
  };
  let error = "",
    bot,
    closed = false,
    starting = false;
  const report = (message) => {
    if (error === message) return;
    error = message;
    log(message);
  };
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    settings = {
      ...settings,
      ...saved,
      greeting: { ...defaultGreeting, ...saved.greeting },
      design: { enabled: false, guildId: "", channelId: "", ...saved.design },
    };
    if (
      typeof settings.token !== "string" ||
      typeof settings.enabled !== "boolean"
    )
      throw new Error("settings");
  } catch (e) {
    if (e.code !== "ENOENT") {
      settings.enabled = false;
      settings.token = "";
      report("設定ファイルを読み込めません。設定を保存し直してください");
    }
  }
  const atomic = (target, contents) => {
    const tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, contents, { mode: 0o600 });
    renameSync(tmp, target);
  };
  const save = () => atomic(file, JSON.stringify(settings, null, 2) + "\n");
  const cache = new Map(),
    pending = new Map(),
    failures = new Map();
  // Keep this hook installed even while disconnected: an opted-in command must
  // fail visibly rather than silently falling back to immediate registration.
  const designer = {
    enabled: () => settings.design.enabled,
    run: (task, valid) => {
      check(
        settings.enabled && bot?.designVoice,
        "Discord Botにログインしてください",
      );
      return bot.designVoice(task, valid);
    },
  };
  if (engine.chatVoices) engine.chatVoices.designer = designer;
  function descriptor(kind, notify = true) {
    const text =
      settings.greeting[kind === "enter" ? "enterText" : "leaveText"];
    if (!text) return null;
    const voice = settings.greeting.voiceProfileId
      ? engine.config.voiceProfiles.find(
          (v) => v.id === settings.greeting.voiceProfileId,
        )
      : defaultVoice;
    if (!voice) {
      if (notify) report("入室・退出メッセージの声を選んで保存してください");
      return null;
    }
    const snapshot = {
      text,
      voice: structuredClone(voice),
      provider: engine.config.provider,
      deliveryCaptionMode: engine.config.deliveryCaptionMode ?? "append",
    };
    const hash = createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex");
    return { ...snapshot, hash, path: join(dataDir, `discord-${kind}.wav`) };
  }
  function cached(kind, desc) {
    if (cache.get(kind)?.hash === desc.hash) return cache.get(kind).pcm;
    if (settings.hashes?.[kind] === desc.hash && existsSync(desc.path)) {
      try {
        const pcm = toDiscordPcm(readFileSync(desc.path));
        cache.set(kind, { hash: desc.hash, pcm });
        return pcm;
      } catch {
        /* regenerate invalid cache */
      }
    }
    return null;
  }
  async function greeting(kind, generate = kind === "enter") {
    if (closed && kind !== "leave") return null;
    const desc = descriptor(kind);
    if (!desc) return null;
    const pcm = cached(kind, desc);
    if (pcm || !generate) return pcm;
    const key = `${kind}:${desc.hash}`;
    if (pending.has(key)) return pending.get(key);
    const work = Promise.resolve()
      .then(() => engine.preview(desc.text, desc.voice))
      .then((wav) => {
        const converted = toDiscordPcm(wav);
        if (!closed && descriptor(kind)?.hash === desc.hash) {
          atomic(desc.path, wav);
          settings.hashes = { ...settings.hashes, [kind]: desc.hash };
          save();
          cache.set(kind, { hash: desc.hash, pcm: converted });
          failures.delete(kind);
          return converted;
        }
        return null;
      })
      .catch((cause) => {
        if (!closed && descriptor(kind, false)?.hash === desc.hash) {
          const raw =
            typeof cause?.message === "string"
              ? cause.message
              : "音声を生成できません";
          const message = (
            settings.token ? raw.replaceAll(settings.token, "[非表示]") : raw
          )
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .slice(0, 300);
          failures.set(kind, { hash: desc.hash, message });
          report(
            `${kind === "enter" ? "入室" : "退出"}メッセージの生成に失敗しました: ${message}`,
          );
        }
        return null;
      })
      .finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  }
  function prepare() {
    // Queue enter before leave; do not delay login or hold an HTTP request for TTS.
    void greeting("enter", true);
    void greeting("leave", true);
  }
  function greetingState(kind) {
    const text =
      settings.greeting[kind === "enter" ? "enterText" : "leaveText"];
    if (!text) return { state: "disabled" };
    const desc = descriptor(kind, false);
    if (!desc) return { state: "voice-missing" };
    if (cached(kind, desc)) return { state: "ready" };
    if (pending.has(`${kind}:${desc.hash}`)) return { state: "generating" };
    const failure = failures.get(kind);
    if (failure?.hash === desc.hash)
      return { state: "error", error: failure.message };
    return { state: "pending" };
  }
  async function stopBot() {
    const old = bot;
    bot = undefined;
    if (old) await old.close();
  }
  async function startBot(connectSaved = true) {
    if (closed || !settings.enabled || !settings.token || bot) return;
    if (!installed) {
      report("cd discord && npm ci を実行してください");
      return;
    }
    starting = true;
    try {
      const created = await botFactory({
        engine,
        transcription,
        token: settings.token,
        greeting,
        greetingText: (kind) =>
          settings.greeting[kind === "enter" ? "enterText" : "leaveText"],
        onError: report,
        designSettings: () => settings.design,
      });
      if (closed) {
        await created.close();
        return;
      }
      bot = created;
      prepare();
      if (connectSaved && settings.autoConnect && settings.channelId)
        await bot.connect(settings.guildId, settings.channelId);
    } catch {
      report(
        "Botの起動に失敗しました。トークン・依存パッケージ・ネットワークを確認してください",
      );
    } finally {
      starting = false;
    }
  }
  // Mutations and startup are serialized. Polling never waits for a voice connection.
  let tail = Promise.resolve();
  function serial(fn) {
    const result = tail.then(() => {
      if (closed) fail("終了中です", 503);
      return fn();
    });
    tail = result.catch(() => {});
    return result;
  }
  const ready = serial(startBot);
  ready.catch(() => {});
  async function status() {
    let channels = [];
    try {
      channels = (await bot?.channels()) ?? [];
    } catch {
      report("チャンネル一覧を取得できません");
    }
    return {
      installed,
      enabled: settings.enabled,
      tokenSet: !!settings.token,
      state: starting
        ? "connecting"
        : (bot?.status().state ?? (error ? "error" : "logged-out")),
      error: error || bot?.status().error || "",
      transcription: {
        enabled: !!transcription,
        ready: !!transcription?.ready(),
        count: 0,
        error: "",
        ...transcription?.snapshot?.(),
        ...bot?.status().transcription,
      },
      botName: bot?.status().botName ?? "",
      inviteUrl: bot?.status().inviteUrl ?? "",
      channels,
      textChannels: (await bot?.textChannels?.()) ?? [],
      design: { ...settings.design },
      guildId: settings.guildId,
      channelId: settings.channelId,
      autoConnect: settings.autoConnect,
      greeting: { ...settings.greeting },
      defaultGreetingVoice: { ...defaultVoice },
      greetingAudio: {
        enter: greetingState("enter"),
        leave: greetingState("leave"),
      },
    };
  }
  const validateChannel = async (channel) => {
    check(
      channel &&
        /^\d{17,20}$/.test(channel.guildId) &&
        /^\d{17,20}$/.test(channel.channelId),
      "チャンネルIDが不正です",
    );
    const available = (await bot?.channels()) ?? [];
    check(
      available.some(
        (c) =>
          c.guildId === channel.guildId &&
          c.channelId === channel.channelId &&
          c.canSpeak,
      ),
      "選択したチャンネルに接続・発言できません",
    );
  };
  async function mutate({ method, path, body: b }) {
    if (method === "PUT" && path === "settings") {
      check(b && typeof b === "object" && !Array.isArray(b), "設定が必要です");
      if ("enabled" in b)
        check(typeof b.enabled === "boolean", "Botを使う設定が不正です");
      if ("token" in b)
        check(
          typeof b.token === "string" &&
            b.token.length > 0 &&
            b.token.length <= 200 &&
            !/\s/.test(b.token),
          "トークンは空白のない200文字以内で指定してください",
        );
      if ("channel" in b) await validateChannel(b.channel);
      const previous = settings;
      settings = {
        ...settings,
        ...("enabled" in b ? { enabled: b.enabled } : {}),
        ...("token" in b ? { token: b.token } : {}),
        ...(b.channel
          ? { guildId: b.channel.guildId, channelId: b.channel.channelId }
          : {}),
      };
      try {
        save();
      } catch {
        settings = previous;
        fail("設定を保存できません", 500);
      }
      error = "";
      if (!settings.enabled || settings.token !== previous.token)
        await stopBot();
      if (settings.enabled) {
        if (!bot) await startBot();
        else if (
          settings.guildId !== previous.guildId ||
          settings.channelId !== previous.channelId
        ) {
          if (settings.autoConnect) {
            prepare();
            await bot.connect(settings.guildId, settings.channelId);
          }
        }
      }
    } else if (method === "PUT" && path === "design") {
      check(b && typeof b.enabled === "boolean", "試聴モードの設定が不正です");
      const available = (await bot?.textChannels?.()) ?? [];
      check(
        !b.enabled ||
          available.some(
            (c) =>
              c.guildId === b.guildId &&
              c.channelId === b.channelId &&
              c.canSend,
          ),
        "投稿・添付できるテキストチャンネルを選んでください",
      );
      const previous = settings;
      settings = {
        ...settings,
        design: {
          enabled: b.enabled,
          guildId: b.enabled ? b.guildId : settings.design.guildId,
          channelId: b.enabled ? b.channelId : settings.design.channelId,
        },
      };
      try {
        save();
      } catch {
        settings = previous;
        fail("設定を保存できません", 500);
      }
      bot?.cancelDesigns?.();
      error = "";
    } else if (method === "PUT" && path === "greeting") {
      check(b && typeof b === "object", "メッセージ設定が必要です");
      for (const key of ["enterText", "leaveText"])
        check(
          typeof b[key] === "string" &&
            [...b[key]].length <= 100 &&
            !/[<>\u0000-\u001f\u007f]/.test(b[key]),
          "入室・退出メッセージは100文字以内で指定してください",
        );
      check(
        engine.config.voiceProfiles.some((v) => v.id === b.voiceProfileId) ||
          b.voiceProfileId === "",
        "登録済みの声を選んでください",
      );
      const previous = settings;
      settings = {
        ...settings,
        greeting: {
          enterText: b.enterText,
          leaveText: b.leaveText,
          voiceProfileId: b.voiceProfileId,
        },
      };
      try {
        save();
      } catch {
        settings = previous;
        fail("設定を保存できません", 500);
      }
      error = "";
      prepare();
    } else if (method === "DELETE" && path === "token") {
      await stopBot();
      delete settings.token;
      save();
      error = "";
    } else if (method === "POST" && path === "connect") {
      check(
        settings.enabled && settings.token,
        "Botを使うをオンにしてトークンを保存してください",
      );
      await startBot(false);
      check(bot, "Botにログインしてください");
      await validateChannel(settings);
      settings.autoConnect = true;
      save();
      error = "";
      prepare();
      await bot.connect(settings.guildId, settings.channelId);
    } else if (method === "POST" && path === "disconnect") {
      settings.autoConnect = false;
      save();
      error = "";
      await bot?.disconnect({ farewell: true });
    } else fail("APIがありません", 404);
    return { status: 200, data: await status() };
  }
  return {
    id: "discord",
    title: "Discord Bot",
    adminScript: new URL("./admin.js", import.meta.url),
    adminAsset: "discord/admin.js",
    ready,
    voiceProfileUses: () =>
      settings.greeting.voiceProfileId
        ? { [settings.greeting.voiceProfileId]: ["Discord入退室"] }
        : {},
    admin: (request) =>
      request.method === "GET" && request.path === "status"
        ? status().then((data) => ({ status: 200, data }))
        : serial(async () => {
            try {
              return await mutate(request);
            } catch (e) {
              if (e.status) throw e;
              report("Botの操作に失敗しました");
              return { status: 200, data: await status() };
            }
          }),
    close: async () => {
      if (engine.chatVoices?.designer === designer)
        engine.chatVoices.designer = null;
      // During shutdown only the already-cached farewell remains available.
      const active = bot;
      bot = undefined;
      const closing = active?.close();
      closed = true;
      await closing;
      await tail;
    },
  };
}
