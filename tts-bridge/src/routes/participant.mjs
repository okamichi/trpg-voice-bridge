import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { check, HttpError, hash, voiceSchema } from "../contracts.mjs";
import {
  characterSettings,
  saveCharacter,
  removeCharacter,
  removeVoiceProfile,
  createCharacter,
} from "../character-settings.mjs";
import { json, body } from "../http-util.mjs";

/** Player and Chatter: joining, chat, character settings, room state and audio. Returns true when handled. */
export async function participantRoutes(ctx, req, res, url) {
  const path = url.pathname,
    method = req.method;
  const {
    store,
    engine,
    publicOrigin,
    players,
    invites,
    previews,
    connections,
    wave,
    idempotent,
    origin,
    admin,
    player,
    participantOrigin,
    chatterOrigin,
    authAdmin,
    voices,
    voiceProfileUses,
    registerVoice,
    changed,
  } = ctx;
  if (
    ["/api/v1/join", "/api/v1/chatter/join"].includes(path) &&
    method === "POST"
  ) {
    const extensionOrigin =
      path === "/api/v1/chatter/join" ? chatterOrigin(req) : null;
    if (!extensionOrigin) origin(req);
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
      id: randomUUID(),
      kind: extensionOrigin ? "chatter" : "player",
      origin: extensionOrigin,
      host: req.headers.host,
      roomId: store.config.roomId,
      sessionId: engine.sessionId,
      expires: Date.now() + 12 * 3600000,
    });
    if (extensionOrigin)
      return json(res, 200, {
        token,
        roomId: store.config.roomId,
        sessionId: engine.sessionId,
        expires: players.get(hash(token)).expires,
      });
    const secure =
      req.headers.host === new URL(publicOrigin || ctx.localOrigin).host &&
      (publicOrigin || ctx.localOrigin).startsWith("https:");
    res.setHeader(
      "Set-Cookie",
      `trpg_player=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`,
    );
    return json(res, 200, { roomId: store.config.roomId });
  }
  if (path === "/api/v1/leave" && method === "POST") {
    participantOrigin(req);
    const p = player(req);
    p.revoked = true;
    for (const [key, value] of players) if (value === p) players.delete(key);
    for (const [ws, conn] of connections)
      if (conn.auth === p) ws.close(1000, "participant left");
    if (p.kind !== "chatter")
      res.setHeader(
        "Set-Cookie",
        "trpg_player=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      );
    return json(res, 200, { ok: true });
  }
  const chatRoute =
    /^\/api\/v1\/rooms\/([\w.-]+)\/(messages|message-changes)$/.exec(path);
  if (chatRoute) {
    participantOrigin(req);
    const p = player(req);
    check(chatRoute[1] === store.config.roomId, "別の卓です", 403);
    check(
      store.config.publishTextToPlayers,
      "チャットと本文の共有は停止中です",
      403,
    );
    if (method === "POST" && chatRoute[2] === "messages") {
      const input = await body(req);
      player(req); // Authentication can expire while the body is arriving.
      const result = engine.participantMessage(input, p);
      return json(res, result.http, result);
    }
    if (method === "GET") {
      engine.prune();
      const query = new URL(req.url, ctx.localOrigin).searchParams;
      const number = (name, fallback) =>
        query.has(name) ? Number(query.get(name)) : fallback;
      const result =
        chatRoute[2] === "messages"
          ? store.chat.list({
              before: number("before"),
              after: number("after"),
              limit: number("limit", 100),
            })
          : store.chat.changes({
              since: number("since"),
              generation: number("generation"),
              limit: number("limit", 100),
            });
      return json(res, 200, result);
    }
    throw new HttpError(405, "許可されていない操作です");
  }
  const settingsRoute =
    /^\/api\/v1\/rooms\/([\w.-]+)\/(characters(?:\/([\w.-]+))?|voice-profiles\/([\w.-]+)|voices|previews)$/.exec(
      path,
    );
  if (settingsRoute) {
    participantOrigin(req);
    player(req);
    check(settingsRoute[1] === store.config.roomId, "別の卓です", 403);
    if (method === "GET" && settingsRoute[2] === "characters")
      return json(res, 200, {
        ...characterSettings(store),
        voiceProfileUses: voiceProfileUses(),
      });
    if (method === "POST" && settingsRoute[2] === "characters") {
      const b = await body(req);
      player(req);
      const result = await idempotent(req, b, () => {
        player(req);
        const value = createCharacter(store, b);
        engine.notify("characters.changed");
        return { value };
      });
      return json(res, 201, result);
    }
    if (method === "DELETE" && settingsRoute[4]) {
      const b = await body(req, 65536);
      const result = await idempotent(req, b, () => {
        player(req);
        const previous = store.config;
        const value = removeVoiceProfile(
          store,
          settingsRoute[4],
          b,
          voiceProfileUses(),
        );
        changed(previous);
        return { value };
      });
      return json(res, 200, result);
    }
    if (method === "GET" && settingsRoute[2] === "voices")
      return json(res, 200, await voices());
    if (["PATCH", "DELETE"].includes(method) && settingsRoute[3]) {
      const b = await body(req, 65536);
      const result = await idempotent(req, b, () => {
        player(req);
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
        await idempotent(req, b, () => {
          player(req);
          return registerVoice(b);
        }),
      );
    }
    if (method === "POST" && settingsRoute[2] === "previews") {
      const b = await body(req);
      const preview = await idempotent(req, b, async () => {
        player(req);
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
  const room = /^\/api\/v1\/rooms\/([\w.-]+)\/(state|audio\/([\w-]+))$/.exec(
    path,
  );
  if (room && method === "GET") {
    if (authAdmin(req)) admin(req);
    else {
      participantOrigin(req);
      player(req);
    }
    check(room[1] === store.config.roomId, "別の卓です", 403);
    if (room[2] === "state")
      return json(res, 200, {
        ...engine.snapshot(),
        ...(!authAdmin(req) ? { participantId: player(req).id } : {}),
      });
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
    // Player asks for Opus only after checking that its browser decodes it.
    const delivered = await engine.deliveredAudio(
      a,
      url.searchParams.get("format") === "opus",
    );
    return wave(res, readFileSync(delivered.file), delivered.mediaType);
  }
}
