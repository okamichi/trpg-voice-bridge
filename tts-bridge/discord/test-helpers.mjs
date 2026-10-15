import { EventEmitter } from "node:events";
export const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
export async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await tick();
  }
  throw new Error("condition timed out");
}
export function fakeEngine() {
  const engine = new EventEmitter();
  engine.meta = { bootId: "boot", sessionId: "session", playbackEpoch: 0 };
  engine.seq = 0;
  engine.metadata = () => ({ ...engine.meta });
  engine.store = { maxSeq: () => engine.seq };
  engine.config = {
    voiceProfiles: [{ id: "voice", name: "Voice" }],
    provider: { type: "mock" },
  };
  engine.audioFile = () => engine.file;
  return engine;
}
export function fakeDiscord({ autoReady = true, autoIdle = true } = {}) {
  const calls = [],
    connections = [],
    resources = [],
    players = [],
    clients = [];
  let failPlay = false;
  const guilds = new Map();
  for (const [id, name] of [
    ["11111111111111111", "A"],
    ["22222222222222222", "B"],
  ]) {
    const guild = {
      id,
      name,
      voiceAdapterCreator: {},
      members: { me: {} },
      channels: { cache: new Map() },
    };
    for (const [index, allowed] of [
      [1, true],
      [2, false],
      [3, true],
    ]) {
      const channelId = id.slice(0, -1) + index;
      guild.channels.cache.set(channelId, {
        id: channelId,
        guild,
        name: `room${index}`,
        rawPosition: index,
        type: 2,
        permissionsFor: () => ({ has: () => allowed }),
      });
    }
    guilds.set(id, guild);
  }
  class Client extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.guilds = { cache: guilds };
      clients.push(this);
    }
    async login() {
      this.user = { id: "123", tag: "Test Bot" };
      this.ready = true;
      this.emit("ready");
    }
    isReady() {
      return !!this.ready;
    }
    destroy() {
      this.ready = false;
      calls.push("logout");
    }
  }
  class Connection extends EventEmitter {
    constructor(options) {
      super();
      this.joinConfig = options;
      this.state = { status: "connecting" };
    }
    set(status) {
      const old = this.state;
      this.state = { status };
      this.emit("stateChange", old, this.state);
      this.emit(status);
    }
    subscribe() {
      calls.push("subscribe");
      return { unsubscribe: () => calls.push("unsubscribe") };
    }
    destroy() {
      calls.push("destroy");
      this.set("destroyed");
    }
  }
  const deps = {
    Client,
    GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 },
    Events: { ClientReady: "ready" },
    ChannelType: { GuildVoice: 2 },
    PermissionFlagsBits: { ViewChannel: 1, Connect: 2, Speak: 4 },
    AudioPlayerStatus: { Idle: "idle" },
    VoiceConnectionStatus: {
      Ready: "ready",
      Disconnected: "disconnected",
      Connecting: "connecting",
      Signalling: "signalling",
      Destroyed: "destroyed",
    },
    StreamType: { Raw: "raw" },
    createAudioPlayer() {
      const player = new EventEmitter();
      player.stop = () => {
        calls.push("stop");
        player.emit("idle");
      };
      player.play = (resource) => {
        if (failPlay) {
          failPlay = false;
          throw new Error("sync play error");
        }
        resources.push(resource);
        calls.push("play");
        if (autoIdle) queueMicrotask(() => player.emit("idle"));
      };
      players.push(player);
      return player;
    },
    createAudioResource: (stream, options) => ({ stream, options }),
    joinVoiceChannel(options) {
      const existing = connections.find(
        (c) =>
          c.joinConfig.guildId === options.guildId &&
          c.state.status !== "destroyed",
      );
      const connection = existing ?? new Connection(options);
      if (!existing) connections.push(connection);
      connection.joinConfig = options;
      if (autoReady) queueMicrotask(() => connection.set("ready"));
      return connection;
    },
    entersState(target, status, signal) {
      if (target.state.status === status) return Promise.resolve(target);
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          target.off(status, ready);
          signal.removeEventListener("abort", abort);
        };
        const ready = () => {
          cleanup();
          resolve(target);
        };
        const abort = () => {
          cleanup();
          reject(new Error("aborted"));
        };
        target.on(status, ready);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  };
  return {
    deps,
    calls,
    connections,
    resources,
    players,
    clients,
    failNextPlay: () => {
      failPlay = true;
    },
  };
}
