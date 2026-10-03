import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Store, initialConfig } from "./store.mjs";
import { Engine } from "./engine.mjs";
import {
  check,
  HttpError,
  hash,
  voiceSchema,
  sourceKey,
} from "./contracts.mjs";
const webRoot = new URL("../web/", import.meta.url);
const equal = (a, b) => {
  const x = Buffer.from(a ?? ""),
    y = Buffer.from(b ?? "");
  return x.length === y.length && timingSafeEqual(x, y);
};
const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};
async function body(req, limit = 16384) {
  check(
    (req.headers["content-type"] ?? "").startsWith("application/json"),
    "JSONが必要です",
    415,
  );
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    check(size <= limit, "要求が大きすぎます", 413);
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, "JSON形式が不正です");
  }
}
export function createApp({
  dataDir,
  profiles = {},
  localOrigin = "http://127.0.0.1:8090",
  publicOrigin = "",
  providerOptions = {},
  initial,
} = {}) {
  const store = new Store(dataDir, initial ?? initialConfig(profiles)),
    engine = new Engine(store, providerOptions);
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
    disconnects = new Map();
  let invitationGeneration = 0;
  const authAdmin = (req) =>
    equal(req.headers.authorization, `Bearer ${store.secrets.admin}`);
  const authCollector = (req) =>
    equal(req.headers.authorization, `Bearer ${store.secrets.collector}`);
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
  function player(req) {
    const token = (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("trpg_player="))
      ?.slice(12);
    const p = players.get(hash(token ?? ""));
    check(
      p && p.sessionId === engine.sessionId && p.expires > Date.now(),
      "参加資格が必要です",
      401,
    );
    return p;
  }
  const admin = (req) => {
    origin(req, true);
    check(authAdmin(req), "管理トークンが必要です", 401);
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
  function wave(res, wav) {
    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": wav.length,
    });
    res.end(wav);
  }
  async function idempotent(req, b, fn) {
    const key = req.headers["idempotency-key"];
    check(
      typeof key === "string" && /^[\w-]{1,120}$/.test(key),
      "Idempotency-Keyが必要です",
    );
    const k = req.method + req.url + key,
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
    const preview = req.url === "/api/v1/admin/previews";
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
          entry.bytes = Buffer.isBuffer(value) ? value.length : 0;
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
  function persist(c, revision) {
    check(
      c.roomId === store.config.roomId,
      "卓IDの変更には別データディレクトリを使用してください",
    );
    const before = store.config;
    for (const v of before.voiceProfiles)
      if (!c.voiceProfiles?.some((x) => x.id === v.id)) {
        check(
          !c.characters?.some((x) => x.voiceProfileId === v.id),
          "使用中の声は削除できません",
          409,
        );
      }
    const saved = store.save(c, revision);
    engine.configChanged(before);
    return saved;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      check(hosts.has(req.headers.host), "許可されていないHostです", 403);
      const url = new URL(req.url, localOrigin),
        path = url.pathname,
        method = req.method;
      if (path === "/healthz" && method === "GET")
        return json(res, 200, { status: "ok" });
      const staticFiles = {
        "/player/": ["player.html", "text/html"],
        "/admin/": ["admin.html", "text/html"],
        "/web/style.css": ["style.css", "text/css"],
        "/web/player.js": ["player.js", "text/javascript"],
        "/web/admin.js": ["admin.js", "text/javascript"],
        "/web/playback.js": ["playback.js", "text/javascript"],
      };
      if (method === "GET" && staticFiles[path]) {
        if (path === "/admin/" || path === "/web/admin.js") origin(req, true);
        const [f, mime] = staticFiles[path];
        res.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` });
        return res.end(readFileSync(new URL(f, webRoot)));
      }
      if (path.startsWith("/api/v1/admin/")) {
        admin(req);
        if (path === "/api/v1/admin/config") {
          if (method === "GET") return json(res, 200, store.config);
          if (method === "PUT") {
            const b = await body(req, 1024 * 1024);
            return json(res, 200, persist(b, b.revision));
          }
        }
        if (path === "/api/v1/admin/diagnostics" && method === "GET") {
          let tts;
          try {
            if (store.config.provider.type === "mock") tts = { status: "mock" };
            else {
              const r = await fetch(`${store.config.provider.baseUrl}/health`, {
                signal: AbortSignal.timeout(5000),
              });
              check(r.ok, "TTS診断失敗", 502);
              const h = await r.json();
              tts = { status: h.status, model: h.model, runtime: h.runtime };
            }
          } catch (e) {
            tts = { status: "unreachable", error: e.message };
          }
          return json(res, 200, {
            ...engine.metadata(),
            accepting: engine.accepting,
            tts,
            degraded: engine.degraded,
            lastError: engine.lastError,
            pending: engine.queue.length,
            busy: engine.busy,
            audioBytes: engine.audioBytes(),
            collectors: [...engine.collectors.values()].map((c) => ({
              ...c,
              online: Date.now() - c.seen < 60000,
            })),
            players: [...connections.values()].map((c) => ({
              clientId: c.clientId,
              state: c.state,
              seen: c.seen,
            })),
            orders: [...engine.orders.values()].slice(-30).map((o) => ({
              ...engine.publicOrder(o),
              generationMs: o.generationMs,
            })),
          });
        }
        if (path === "/api/v1/admin/unmapped-speakers" && method === "GET")
          return json(
            res,
            200,
            [...engine.unmapped].map(([id, u]) => ({ id, ...u })),
          );
        if (
          path.startsWith("/api/v1/admin/unmapped-speakers/") &&
          method === "DELETE"
        ) {
          engine.unmapped.delete(path.split("/").at(-1));
          return json(res, 200, { ok: true });
        }
        if (
          path === "/api/v1/admin/providers/irodori-local/voices" &&
          method === "GET"
        ) {
          if (store.config.provider.type === "mock")
            return json(res, 200, [{ id: "none", no_ref: true }]);
          const r = await fetch(
            `${store.config.provider.baseUrl}/v1/audio/voices`,
            { signal: AbortSignal.timeout(5000) },
          );
          check(r.ok, "参照voice一覧の取得失敗", 502);
          const d = await r.json();
          return json(
            res,
            200,
            (d.data ?? []).map((v) => ({ id: v.id, no_ref: v.no_ref })),
          );
        }
        const entity =
          /^\/api\/v1\/admin\/(characters|voice-profiles)(?:\/([\w.-]+))?$/.exec(
            path,
          );
        if (entity) {
          const collection =
              entity[1] === "characters" ? "characters" : "voiceProfiles",
            entityId = entity[2],
            items = store.config[collection];
          if (method === "GET") {
            const value = entityId
              ? items.find((x) => x.id === entityId)
              : items;
            check(value, "見つかりません", 404);
            return json(res, 200, value);
          }
          if (["POST", "PATCH", "DELETE"].includes(method)) {
            const b = await body(req);
            const result = await idempotent(req, b, () => {
              const c = structuredClone(store.config);
              let value;
              if (method === "POST") {
                value = { ...b.value, id: randomUUID() };
                if (collection === "voiceProfiles") value.revision = 1;
                if (collection === "characters" && b.newVoice) {
                  const v = { ...b.newVoice, id: randomUUID(), revision: 1 };
                  c.voiceProfiles.push(v);
                  value.voiceProfileId = v.id;
                }
                c[collection].push(value);
              } else {
                const index = c[collection].findIndex((x) => x.id === entityId);
                check(index >= 0, "見つかりません", 404);
                if (method === "DELETE") {
                  if (collection === "voiceProfiles") {
                    const users = c.characters.filter(
                      (x) => x.voiceProfileId === entityId,
                    );
                    check(
                      !users.length,
                      `使用中: ${users.map((x) => x.displayName).join("、")}`,
                      409,
                    );
                  }
                  c[collection].splice(index, 1);
                  value = { deleted: entityId };
                } else {
                  if (collection === "characters" && b.newVoice) {
                    const v = { ...b.newVoice, id: randomUUID(), revision: 1 };
                    c.voiceProfiles.push(v);
                    b.value = { ...b.value, voiceProfileId: v.id };
                  }
                  value = { ...c[collection][index], ...b.value, id: entityId };
                  c[collection][index] = value;
                }
              }
              persist(c, b.revision);
              return { value, revision: store.config.revision };
            });
            return json(res, 200, result);
          }
        }
        if (path === "/api/v1/admin/previews" && method === "POST") {
          const b = await body(req);
          const wav = await idempotent(req, b, () => {
            voiceSchema(b.voice);
            return engine.preview(b.text, b.voice);
          });
          return wave(res, wav);
        }
        if (path === "/api/v1/admin/commands" && method === "POST") {
          const b = await body(req);
          check(
            typeof b.commandId === "string" &&
              /^[\w-]{1,120}$/.test(b.commandId),
            "commandIdが必要です",
          );
          const old = commands.get(b.commandId);
          if (old) {
            check(old.fingerprint === hash(b), "操作IDの内容が異なります", 409);
            return json(res, 200, old.result);
          }
          check(commands.size < 2000, "操作上限です", 429);
          let result = { ok: true };
          if (b.command === "replay") {
            result = engine.replay(b.orderId);
          } else if (b.command === "start") {
            engine.accepting = true;
            engine.pump();
          } else if (b.command === "stop") engine.accepting = false;
          else if (b.command === "reset") engine.reset();
          else if (b.command === "end") {
            engine.reset(true);
            invites.clear();
            players.clear();
            for (const ws of wss.clients) ws.close(1000, "session ended");
          } else if (b.command === "recover-provider") {
            engine.degraded = false;
            engine.lastError = null;
            engine.pump();
          } else if (b.command === "release-collector")
            engine.collectors.clear();
          else if (b.command === "invite") {
            invitationGeneration++;
            invites.clear();
            const token = randomBytes(32).toString("hex");
            invites.set(hash(token), {
              expires: Date.now() + 3600000,
              sessionId: engine.sessionId,
              generation: invitationGeneration,
            });
            result = {
              url: `${publicOrigin || localOrigin}/player/#invite=${token}`,
              expires: Date.now() + 3600000,
            };
          } else throw new HttpError(422, "不明なコマンドです");
          commands.set(b.commandId, {
            fingerprint: hash(b),
            result,
            time: Date.now(),
          });
          return json(res, 200, result);
        }
        throw new HttpError(404, "管理APIが見つかりません");
      }
      if (path === "/api/v1/join" && method === "POST") {
        origin(req);
        const b = await body(req);
        const invite = invites.get(hash(b.invite ?? ""));
        check(
          invite &&
            invite.expires > Date.now() &&
            invite.sessionId === engine.sessionId,
          "招待が失効しています",
          401,
        );
        check(players.size < 200, "参加者上限です", 429);
        const token = randomBytes(32).toString("hex");
        players.set(hash(token), {
          sessionId: engine.sessionId,
          expires: Date.now() + 12 * 3600000,
        });
        const secure =
          req.headers.host === new URL(publicOrigin || localOrigin).host &&
          (publicOrigin || localOrigin).startsWith("https:");
        res.setHeader(
          "Set-Cookie",
          `trpg_player=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`,
        );
        return json(res, 200, { roomId: store.config.roomId });
      }
      if (path.startsWith("/api/v1/collectors/") && method === "POST") {
        collector(req);
        const b = await body(req);
        if (path === "/api/v1/collectors/disconnect") {
          const key = sourceKey(b.source),
            old = engine.collectors.get(key);
          check(
            old?.collectorId === b.collectorId,
            "指定Collectorではありません",
            403,
          );
          engine.collectors.delete(key);
          return json(res, 200, { ok: true });
        }
        check(
          [
            "/api/v1/collectors/connect",
            "/api/v1/collectors/heartbeat",
          ].includes(path),
          "不明なCollector APIです",
          404,
        );
        return json(res, 200, engine.connect(b));
      }
      if (path === "/api/v1/events" && method === "POST") {
        collector(req);
        const b = await body(req),
          result = engine.ingress(b, req.headers["x-collector-id"]);
        return json(res, result.http, result);
      }
      const room =
        /^\/api\/v1\/rooms\/([\w.-]+)\/(state|audio\/([\w-]+))$/.exec(path);
      if (room && method === "GET") {
        origin(req);
        if (authAdmin(req)) admin(req);
        else player(req);
        check(room[1] === store.config.roomId, "別の卓です", 403);
        if (room[2] === "state") return json(res, 200, engine.snapshot());
        const a = engine.audio.get(room[3]);
        check(
          a &&
            a.retainUntil > Date.now() &&
            [...engine.orders.values()].some(
              (o) =>
                o.status === "ready" &&
                o.epoch === engine.playbackEpoch &&
                o.ready?.audio.id === a.id,
            ),
          "音声が期限切れです",
          404,
        );
        return wave(res, readFileSync(a.file));
      }
      throw new HttpError(404, "見つかりません");
    } catch (e) {
      if (!res.headersSent) {
        if (e.status === 429) res.setHeader("Retry-After", "5");
        json(res, e.status ?? 502, {
          error:
            e.status || e.name === "TimeoutError"
              ? e.message
              : "処理に失敗しました",
          ...(e.status === 409 ? { revision: store.config.revision } : {}),
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
  server.on("upgrade", (req, socket, head) => {
    try {
      check(
        req.url === "/ws" &&
          hosts.has(req.headers.host) &&
          origins.has(req.headers.origin),
        "WS Originが不正です",
        403,
      );
      const p = player(req);
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
        check(
          p.sessionId === engine.sessionId && p.expires > Date.now(),
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
            last = disconnects.get(hash(req.headers.cookie ?? "") + b.clientId);
          disconnects.delete(hash(req.headers.cookie ?? "") + b.clientId);
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
      if (conn.clientId)
        disconnects.set(
          hash(req.headers.cookie ?? "") + conn.clientId,
          Date.now(),
        );
    });
  });
  engine.on("notification", (n) => {
    for (const [ws, c] of connections) {
      if (
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
      if (
        now - c.seen > 60000 ||
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
    for (const map of [requests, commands])
      for (const [k, v] of map) if (now - v.time > 600000) map.delete(k);
  }, 20000);
  heartbeat.unref();
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    store,
    engine,
    wss,
    close: async () => {
      clearInterval(heartbeat);
      engine.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => server.close(r));
      while (engine.busy) await new Promise((r) => setTimeout(r, 20));
      store.close();
    },
  };
}
