import { chatterDownload } from "../chatter/zip.mjs";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { readAsset } from "./runtime/assets.mjs";
import { Store, initialConfig } from "./store.mjs";
import { Engine } from "./engine.mjs";
import { check, HttpError, hash } from "./contracts.mjs";
import { equal, json } from "./http-util.mjs";
import { publicRoutes } from "./routes/public.mjs";
import { adminRoutes } from "./routes/admin.mjs";
import { participantRoutes } from "./routes/participant.mjs";
import { collectorRoutes } from "./routes/collector.mjs";
export function securityHeaders(res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  );
}
export function createApp({
  dataDir,
  profiles = {},
  localOrigin = "http://127.0.0.1:8090",
  publicOrigin = "",
  providerOptions = {},
  runtime,
  onShutdown,
  credits = { entries: [], footer: "" },
  initial,
  loadDefaults,
  extensions = [],
  chatterAssetReader = readAsset,
  startupSettings,
  onRestart,
  restartStatus,
} = {}) {
  const store = new Store(dataDir, initial ?? initialConfig(profiles)),
    engine = new Engine(store, providerOptions);
  let download;
  try {
    download = chatterDownload(chatterAssetReader);
  } catch {
    console.error("Chatterのダウンロード用ZIPを作成できませんでした");
  }
  const installedExtensions = new Map();
  for (const factory of extensions) {
    try {
      const extension = factory({ engine, dataDir });
      if (
        !/^[a-z0-9-]+$/.test(extension.id) ||
        installedExtensions.has(extension.id)
      )
        throw new Error("拡張IDが不正です");
      installedExtensions.set(extension.id, extension);
    } catch {
      console.error("拡張の初期化に失敗しました");
    }
  }
  const origins = new Set([
      localOrigin,
      ...(publicOrigin ? [publicOrigin] : []),
    ]),
    hosts = new Set([...origins].map((x) => new URL(x).host));
  const players = new Map(),
    invites = new Map(),
    commands = new Map(),
    requests = new Map(),
    connections = new Map(),
    disconnects = new Map(),
    previews = new Map();
  const bootAccess = randomBytes(32).toString("hex"),
    pairings = new Map();
  const cookie = (req, name) =>
    (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(name + "="))
      ?.slice(name.length + 1);

  const authAdmin = (req) =>
    equal(req.headers.authorization, `Bearer ${store.secrets.admin}`) ||
    equal(cookie(req, "trpg_admin"), store.secrets.admin);
  const authCollector = (req) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const saved = store.auth("collector:" + hash(token));
    return (
      saved && (!req.headers.origin || req.headers.origin === saved.origin)
    );
  };
  function origin(req, admin = false) {
    check(
      !req.headers.origin ||
        (admin
          ? req.headers.origin === localOrigin
          : origins.has(req.headers.origin)),
      "許可されていないOriginです",
      403,
    );
    if (admin)
      check(
        req.headers.host === new URL(localOrigin).host,
        "管理機能はローカルURLで開いてください",
        403,
      );
  }
  const isExtensionOrigin = (value) =>
    typeof value === "string" && /^chrome-extension:\/\/[a-p]{32}$/.test(value);
  // Chrome may omit Origin on host-permitted extension fetches. The explicit
  // header is bound at invitation exchange; a web Origin can never override it.
  function chatterOrigin(req) {
    const value = req.headers.origin ?? req.headers["x-chatter-origin"];
    check(isExtensionOrigin(value), "Chatter拡張から接続してください", 403);
    check(
      !req.headers["x-chatter-origin"] ||
        req.headers["x-chatter-origin"] === value,
      "拡張のOriginが一致しません",
      403,
    );
    return value;
  }
  function participantOrigin(req) {
    if (req.headers.authorization) player(req);
    else origin(req);
  }
  function player(req) {
    const bearer = req.headers.authorization;
    const token = bearer
      ? bearer.replace(/^Bearer /, "")
      : cookie(req, "trpg_player");
    const p = players.get(hash(token ?? ""));
    check(
      p &&
        !p.revoked &&
        p.sessionId === engine.sessionId &&
        p.roomId === store.config.roomId &&
        p.expires > Date.now(),
      "参加資格が必要です",
      401,
    );
    if (p.kind === "chatter") {
      check(
        bearer === `Bearer ${token}` &&
          p.origin === chatterOrigin(req) &&
          p.host === req.headers.host,
        "別の拡張または接続先です",
        403,
      );
    } else {
      check(!bearer, "Cookie参加資格が必要です", 401);
      origin(req);
    }
    return p;
  }
  const admin = (req) => {
    origin(req, true);
    check(authAdmin(req), "起動時の管理用リンクを開いてください", 401);
  };
  const collector = (req) => {
    check(authCollector(req), "Collectorトークンが必要です", 401);
    check(
      !req.headers.origin ||
        req.headers.origin.startsWith("chrome-extension://"),
      "拡張から接続してください",
      403,
    );
  };
  function wave(res, wav, mediaType = "audio/wav") {
    res.writeHead(200, {
      "Content-Type": mediaType,
      "Content-Length": wav.length,
    });
    res.end(wav);
    return true;
  }
  async function idempotent(req, b, fn) {
    const key = req.headers["idempotency-key"];
    check(
      typeof key === "string" && /^[\w-]{1,120}$/.test(key),
      "Idempotency-Keyが必要です",
    );
    const k =
        hash(req.headers.cookie ?? req.headers.authorization ?? "") +
        req.method +
        req.url +
        key,
      fingerprint = hash(b),
      old = requests.get(k);
    if (old) {
      check(
        old.fingerprint === fingerprint,
        "同じ操作IDの内容が異なります",
        409,
      );
      return old.promise;
    }
    check(requests.size < 2000, "操作履歴が満杯です", 429);
    const entry = { fingerprint, time: Date.now(), bytes: 0 };
    // The same limit covers retained preview responses; reserve before generation.
    const preview = req.url.endsWith("/previews");
    if (preview) {
      check(
        [...requests.values()].reduce((n, r) => n + (r.bytes ?? 0), 0) +
          25 * 1024 * 1024 <=
          128 * 1024 * 1024,
        "試聴の保管上限です。10分後に再試行してください",
        429,
      );
      entry.bytes = 25 * 1024 * 1024;
    }
    const promise = Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          const wav = value?.wav ?? value;
          entry.bytes = Buffer.isBuffer(wav) ? wav.length : 0;
          return value;
        },
        (error) => {
          entry.bytes = 0;
          throw error;
        },
      );
    entry.promise = promise;
    requests.set(k, entry);
    return promise;
  }
  const voices = () => engine.references.list(engine.config.provider);
  function voiceProfileUses() {
    const uses = {};
    for (const ext of installedExtensions.values())
      for (const [id, labels] of Object.entries(ext.voiceProfileUses?.() ?? {}))
        uses[id] = [...(uses[id] ?? []), ...labels];
    return uses;
  }
  async function registerVoice(b) {
    const preview = previews.get(b.previewId);
    check(
      preview,
      "試聴音声の保管期限が切れました。もう一度試聴してください",
      404,
    );
    return engine.references.register({
      provider: engine.config.provider,
      voiceId: b.voiceId,
      wav: preview.wav,
    });
  }
  function changed(before) {
    engine.configChanged(before);
  }
  async function restart(kind, input) {
    try {
      return await onRestart(kind, input);
    } catch (e) {
      throw new HttpError(
        e.status ?? 400,
        e.expose ? e.message : "再起動できませんでした",
      );
    }
  }
  // Shared with the route modules. Origins and the invitation can change
  // after start-up, so routes read them through this object.
  const ctx = {
    store,
    engine,
    runtime,
    onShutdown,
    startupSettings,
    onRestart,
    restartStatus,
    restart,
    credits,
    loadDefaults,
    publicOrigin,
    get localOrigin() {
      return localOrigin;
    },
    session: { currentInvite: undefined, invitationGeneration: 0 },
    installedExtensions,
    download,
    players,
    invites,
    commands,
    pairings,
    previews,
    connections,
    bootAccess,
    wave,
    idempotent,
    origin,
    admin,
    player,
    participantOrigin,
    chatterOrigin,
    collector,
    authAdmin,
    voices,
    voiceProfileUses,
    registerVoice,
    changed,
    wss: null,
  };
  let closing = false;
  const server = createServer(async (req, res) => {
    securityHeaders(res);
    try {
      check(!closing, "アプリ終了中です", 503);
      check(hosts.has(req.headers.host), "許可されていないHostです", 403);
      const url = new URL(req.url, localOrigin);
      for (const routes of [
        publicRoutes,
        adminRoutes,
        participantRoutes,
        collectorRoutes,
      ])
        if (await routes(ctx, req, res, url)) return;
      throw new HttpError(404, "見つかりません");
    } catch (e) {
      if (!res.headersSent) {
        if (e.status === 429) res.setHeader("Retry-After", "5");
        json(res, e.status ?? 502, {
          error:
            e.status || e.name === "TimeoutError"
              ? e.message
              : "処理に失敗しました",
        });
      } else res.end();
    }
  });
  server.once("listening", () => {
    if (new URL(localOrigin).port === "0") {
      origins.delete(localOrigin);
      hosts.delete(new URL(localOrigin).host);
      localOrigin = `http://127.0.0.1:${server.address().port}`;
      origins.add(localOrigin);
      hosts.add(new URL(localOrigin).host);
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  ctx.wss = wss;
  server.on("upgrade", (req, socket, head) => {
    if (closing) {
      socket.destroy();
      return;
    }
    try {
      check(
        req.url === "/ws" &&
          hosts.has(req.headers.host) &&
          (origins.has(req.headers.origin) ||
            isExtensionOrigin(req.headers.origin)),
        "WS Originが不正です",
        403,
      );
      const p = isExtensionOrigin(req.headers.origin) ? null : player(req);
      if (!p)
        check(
          [...connections.values()].filter((c) => !c.auth).length < 10,
          "認証待機上限",
          429,
        );
      check(wss.clients.size < 100, "接続上限", 429);
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req, p),
      );
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  const send = (ws, data) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) return ws.close(1013, "slow client");
    // Recheck at delivery, including old notifications replayed on reconnect.
    if (data.type?.startsWith("chat.message.")) {
      if (
        !store.config.publishTextToPlayers ||
        data.generation !== store.chat.metadata().generation ||
        (data.message && !store.chat.get(data.message.id))
      )
        data = {
          ...engine.metadata(),
          notificationSeq: data.notificationSeq,
          type: "chat.redacted",
        };
    }
    if (
      (!store.config.publishTextToPlayers ||
        (data.messageId && !store.chat.get(data.messageId))) &&
      data.text
    ) {
      const { text, ...withoutText } = data;
      data = withoutText;
    }
    ws.send(JSON.stringify(data));
  };
  wss.on("connection", (ws, req, p) => {
    const conn = { state: "locked", seen: Date.now(), clientId: null, auth: p };
    connections.set(ws, conn);
    ws.alive = true;
    const deadline = setTimeout(() => ws.close(1008, "hello required"), 5000);
    ws.on("pong", () => {
      ws.alive = true;
      conn.seen = Date.now();
    });
    ws.on("error", () => {});
    ws.on("message", (data) => {
      try {
        const b = JSON.parse(data);
        if (!p) {
          check(
            b.type === "hello" && typeof b.token === "string",
            "認証が必要です",
            401,
          );
          p = player({
            headers: {
              ...req.headers,
              cookie: undefined,
              authorization: `Bearer ${b.token}`,
            },
          });
          conn.auth = p;
        }
        check(
          !p.revoked &&
            p.roomId === store.config.roomId &&
            p.sessionId === engine.sessionId &&
            p.expires > Date.now(),
          "参加資格が失効しました",
          401,
        );
        if (b.type === "hello" && !conn.clientId) {
          clearTimeout(deadline);
          check(
            typeof b.clientId === "string" && /^[\w-]{1,100}$/.test(b.clientId),
            "clientId",
          );
          conn.clientId = b.clientId;
          const resume = b.resume,
            last = disconnects.get(p.id + b.clientId);
          disconnects.delete(p.id + b.clientId);
          const canResume =
            last &&
            Date.now() - last < 10000 &&
            resume?.bootId === engine.bootId &&
            resume?.sessionId === engine.sessionId &&
            resume?.playbackEpoch === engine.playbackEpoch &&
            Number.isInteger(resume.notificationSeq) &&
            resume.notificationSeq <= engine.notificationSeq &&
            resume.notificationSeq >=
              (engine.history[0]?.notificationSeq ??
                engine.notificationSeq + 1) -
                1;
          send(ws, {
            ...engine.metadata(),
            type: "hello",
            participantId: p.id,
            serverTime: Date.now(),
            baseline: engine.store.maxSeq(),
            resumed: !!canResume,
          });
          if (canResume)
            for (const n of engine.history.filter(
              (n) => n.notificationSeq > resume.notificationSeq,
            ))
              send(ws, n);
          else send(ws, engine.snapshot());
          return;
        }
        check(conn.clientId, "hello required");
        if (
          [
            "player.ready",
            "playback.started",
            "playback.ended",
            "playback.error",
            "player.state",
          ].includes(b.type)
        ) {
          conn.state = [
            "locked",
            "idle",
            "fetching",
            "playing",
            "muted",
            "blocked",
            "disconnected",
          ].includes(b.state)
            ? b.state
            : b.type;
          conn.seen = Date.now();
        }
      } catch {
        ws.close(1008, "invalid message");
      }
    });
    ws.on("close", () => {
      clearTimeout(deadline);
      connections.delete(ws);
      if (conn.clientId) disconnects.set(p.id + conn.clientId, Date.now());
    });
  });
  engine.on("notification", (n) => {
    for (const [ws, c] of connections) {
      if (!c.auth) continue;
      if (
        c.auth.revoked ||
        c.auth.roomId !== store.config.roomId ||
        c.auth.expires <= Date.now() ||
        c.auth.sessionId !== engine.sessionId
      ) {
        ws.close(1008, "expired");
        continue;
      }
      if (c.clientId) send(ws, n);
    }
  });
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [ws, c] of connections) {
      if (!c.auth) continue;
      if (
        now - c.seen > 60000 ||
        c.auth.revoked ||
        c.auth.roomId !== store.config.roomId ||
        c.auth.expires <= now ||
        c.auth.sessionId !== engine.sessionId
      ) {
        ws.terminate();
        continue;
      }
      ws.ping();
    }
    for (const [k, p] of players) if (p.expires < now) players.delete(k);
    for (const [k, t] of disconnects)
      if (now - t > 10000) disconnects.delete(k);
    for (const map of [requests, commands, previews])
      for (const [k, v] of map) if (now - v.time > 600000) map.delete(k);
  }, 20000);
  heartbeat.unref();
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    adminUrl: () => `${localOrigin}/admin/#access=${bootAccess}`,
    get localOrigin() {
      return localOrigin;
    },
    server,
    store,
    engine,
    wss,
    close: async () => {
      closing = true;
      engine.chatVoices.shutdown();
      const referencesClosed = engine.references.close();
      clearInterval(heartbeat);
      await Promise.allSettled(
        [...installedExtensions.values()].map((ext) =>
          Promise.resolve().then(() => ext.close()),
        ),
      );
      engine.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => server.close(r));
      while (engine.busy) await new Promise((r) => setTimeout(r, 20));
      await referencesClosed;
      await engine.chatVoices.drain();
      store.close();
    },
  };
}
