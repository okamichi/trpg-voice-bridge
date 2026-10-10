import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Store, initialConfig } from "./store.mjs";
import {
  characterSettings,
  saveCharacter,
  removeCharacter,
} from "./character-settings.mjs";
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
  if (typeof a !== "string" || typeof b !== "string") return false;
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
  loadDefaults,
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
    disconnects = new Map(),
    previews = new Map();
  let invitationGeneration = 0,
    currentInvite;
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
  const upstream = (...a) => (engine.options.fetchImpl ?? fetch)(...a);
  async function voices() {
    if (store.config.provider.type === "mock")
      return [{ id: "none", no_ref: true }];
    const r = await upstream(
      `${store.config.provider.baseUrl}/v1/audio/voices`,
      {
        signal: AbortSignal.timeout(5000),
      },
    );
    check(r.ok, "参照voice一覧の取得失敗", 502);
    const data = await r.json();
    return (data.data ?? []).map((v) => ({ id: v.id, no_ref: v.no_ref }));
  }
  // Only previews this bridge generated can become reference voices, and
  // existing voice ids are never replaced.
  async function registerVoice(b) {
    check(
      store.config.provider.type !== "mock",
      "モックでは参照音声を登録できません",
      409,
    );
    check(
      typeof b.voiceId === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(b.voiceId) &&
        !["none", "no_ref", "no-ref", "null", "text-only"].includes(
          b.voiceId.toLowerCase(),
        ),
      "参照音声IDは英数字・_・-の64文字以内です（noneなどは使えません）",
    );
    const preview = previews.get(b.previewId);
    check(
      preview,
      "試聴音声の保管期限が切れました。もう一度試聴してください",
      404,
    );
    const taken = "同じIDの参照音声が既にあります。別のIDにしてください";
    check(!(await voices()).some((v) => v.id === b.voiceId), taken, 409);
    const form = new FormData();
    form.append(
      "file",
      new Blob([preview.wav], { type: "audio/wav" }),
      `${b.voiceId}.wav`,
    );
    form.append("voice_id", b.voiceId);
    const r = await upstream(
      `${store.config.provider.baseUrl}/v1/audio/voices`,
      { method: "POST", body: form, signal: AbortSignal.timeout(30000) },
    );
    await r.body?.cancel();
    check(r.status !== 409, taken, 409);
    check(r.ok, `参照音声の登録に失敗しました（TTS HTTP ${r.status}）`, 502);
    return { id: b.voiceId };
  }
  function changed(before) {
    engine.configChanged(before);
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
        "/web/characters.js": ["characters.js", "text/javascript"],
        "/web/player.js": ["player.js", "text/javascript"],
        "/web/admin.js": ["admin.js", "text/javascript"],
        "/web/playback.js": ["playback.js", "text/javascript"],
        "/web/uuid.js": ["uuid.js", "text/javascript"],
      };
      if (method === "GET" && staticFiles[path]) {
        if (path === "/admin/" || path === "/web/admin.js") origin(req, true);
        const [f, mime] = staticFiles[path];
        res.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` });
        return res.end(readFileSync(new URL(f, webRoot)));
      }
      if (path === "/api/v1/admin-login" && method === "POST") {
        origin(req, true);
        const b = await body(req);
        check(
          equal(b.access, bootAccess),
          "管理用リンクが無効です。起動ログを確認してください",
          401,
        );
        res.setHeader(
          "Set-Cookie",
          `trpg_admin=${store.secrets.admin}; HttpOnly; SameSite=Strict; Path=/`,
        );
        return json(res, 200, { ok: true });
      }
      if (path === "/api/v1/pairings" && method === "POST") {
        check(
          req.headers.host === new URL(localOrigin).host,
          "ローカル接続が必要です",
          403,
        );
        check(
          !req.headers.origin ||
            /^chrome-extension:\/\/[a-z]+$/.test(req.headers.origin),
          "拡張から接続してください",
          403,
        );
        const b = await body(req);
        check(
          typeof b.key === "string" && /^[a-f0-9]{64}$/.test(b.key),
          "接続キーが不正です",
        );
        for (const [k, v] of pairings)
          if (v.expires < Date.now()) pairings.delete(k);
        const key = hash(b.key);
        let pending = pairings.get(key);
        if (!pending) {
          check(pairings.size < 20, "接続承認の待機数が上限です", 429);
          pending = {
            id: randomUUID(),
            code: randomBytes(3).toString("hex").toUpperCase(),
            origin: req.headers.origin ?? "",
            expires: Date.now() + 300000,
          };
          pairings.set(key, pending);
        }
        check(
          pending.origin === (req.headers.origin ?? ""),
          "異なる拡張です",
          403,
        );
        return json(res, 200, {
          code: pending.code,
          status: pending.token
            ? "approved"
            : pending.rejected
              ? "rejected"
              : "pending",
          token: pending.token,
        });
      }
      if (path.startsWith("/api/v1/admin/")) {
        admin(req);
        if (path === "/api/v1/admin/config" && method === "GET")
          return json(res, 200, store.config);
        if (path === "/api/v1/admin/provider" && method === "PUT") {
          const b = await body(req);
          store.change((c) => {
            store.compare(c.provider, b.before);
            c.provider.baseUrl = b.baseUrl;
          });
          return json(res, 200, store.config.provider);
        }
        if (path === "/api/v1/admin/subtitles" && method === "PUT") {
          const b = await body(req);
          check(
            typeof b.publishTextToPlayers === "boolean",
            "字幕設定が不正です",
          );
          store.change((c) => {
            store.compare(c.publishTextToPlayers, b.before);
            c.publishTextToPlayers = b.publishTextToPlayers;
          });
          return json(res, 200, {
            publishTextToPlayers: store.config.publishTextToPlayers,
          });
        }
        if (path === "/api/v1/admin/pairings") {
          if (method === "GET")
            return json(
              res,
              200,
              [...pairings.values()]
                .filter(
                  (p) => !p.token && !p.rejected && p.expires > Date.now(),
                )
                .map(({ id, code }) => ({ id, code })),
            );
          if (method === "POST") {
            const b = await body(req),
              p = [...pairings.values()].find((p) => p.id === b.id);
            check(
              p && p.expires > Date.now() && !p.rejected,
              "承認待ちの接続がありません",
              404,
            );
            if (b.approve === true) {
              if (!p.token) {
                p.token = randomBytes(32).toString("hex");
                store.setAuth("collector:" + hash(p.token), {
                  origin: p.origin,
                });
              }
            } else p.rejected = true;
            return json(res, 200, { ok: true });
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
        if (
          path === "/api/v1/admin/providers/irodori-local/voices" &&
          method === "GET"
        )
          return json(res, 200, await voices());
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
          } else if (b.command === "stop") engine.reset();
          else if (b.command === "reset") engine.reset();
          else if (b.command === "end") {
            engine.reset(true);
            invites.clear();
            currentInvite = null;
            players.clear();
            for (const ws of wss.clients) ws.close(1000, "session ended");
          } else if (b.command === "recover-provider") {
            engine.degraded = false;
            engine.lastError = null;
            engine.pump();
          } else if (b.command === "release-collector")
            engine.collectors.clear();
          else if (b.command === "reset-settings") {
            check(b.confirm === true, "初期化の確認が必要です");
            engine.reset();
            const before = store.config;
            store.resetDefaults(loadDefaults?.());
            changed(before);
          } else if (b.command === "revoke-collectors") {
            store.revokeCollectors();
            engine.collectors.clear();
            pairings.clear();
          } else if (b.command === "invite" || b.command === "renew-invite") {
            if (b.command === "invite" && currentInvite?.expires > Date.now())
              result = currentInvite;
            else {
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
                localUrl: `${localOrigin}/player/#invite=${token}`,
                expires: Date.now() + 3600000,
              };
              currentInvite = result;
            }
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
        if (path.endsWith("/heartbeat"))
          check(
            engine.collectors.get(sourceKey(b.source))?.collectorId ===
              b.collectorId,
            "接続が解除されました。拡張から再接続してください",
            409,
          );
        if (
          path.endsWith("/connect") &&
          !store.config.sources.some(
            (s) => sourceKey(s) === sourceKey(b.source),
          )
        )
          store.change((c) => {
            const { adapter, instanceId, contextId } = b.source ?? {};
            c.sources.push({ adapter, instanceId, contextId });
          });
        return json(res, 200, engine.connect(b));
      }
      if (path === "/api/v1/events" && method === "POST") {
        collector(req);
        const b = await body(req),
          result = engine.ingress(b, req.headers["x-collector-id"]);
        return json(res, result.http, result);
      }
      const settingsRoute =
        /^\/api\/v1\/rooms\/([\w.-]+)\/(characters(?:\/([\w.-]+))?|voices|previews)$/.exec(
          path,
        );
      if (settingsRoute) {
        origin(req);
        player(req);
        check(settingsRoute[1] === store.config.roomId, "別の卓です", 403);
        if (method === "GET" && settingsRoute[2] === "characters")
          return json(res, 200, characterSettings(store));
        if (method === "GET" && settingsRoute[2] === "voices")
          return json(res, 200, await voices());
        if (["PATCH", "DELETE"].includes(method) && settingsRoute[3]) {
          const b = await body(req, 65536);
          const result = await idempotent(req, b, () => {
            const previous = store.config;
            const value =
              method === "DELETE"
                ? removeCharacter(store, settingsRoute[3], b)
                : saveCharacter(store, settingsRoute[3], b);
            changed(previous);
            return { value };
          });
          return json(res, 200, result);
        }
        if (method === "POST" && settingsRoute[2] === "voices") {
          const b = await body(req);
          return json(
            res,
            201,
            await idempotent(req, b, () => registerVoice(b)),
          );
        }
        if (method === "POST" && settingsRoute[2] === "previews") {
          const b = await body(req);
          const preview = await idempotent(req, b, async () => {
            voiceSchema(b.voice);
            const wav = await engine.preview(b.text, b.voice),
              id = randomUUID();
            previews.set(id, { wav, time: Date.now() });
            return { wav, id };
          });
          res.setHeader("X-Preview-Id", preview.id);
          return wave(res, preview.wav);
        }
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
    for (const map of [requests, commands, previews])
      for (const [k, v] of map) if (now - v.time > 600000) map.delete(k);
  }, 20000);
  heartbeat.unref();
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    adminUrl: () => `${localOrigin}/admin/#access=${bootAccess}`,
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
