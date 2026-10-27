import { randomBytes } from "node:crypto";
import {
  check,
  HttpError,
  hash,
  voiceSchema,
  DELIVERY_CAPTION_MODES,
  AUDIO_FORMATS,
  DEFAULT_AUDIO_FORMAT,
} from "../contracts.mjs";
import { json, body } from "../http-util.mjs";
import { DEFAULT_SENTENCE_PAUSE_MS } from "../engine.mjs";
import { DEFAULT_SENTENCE_SPLIT_THRESHOLD_CHARS } from "../sentences.mjs";
import { speechModel } from "../tts-api.mjs";

/** Everything under /api/v1/admin/. Requires the admin cookie or token on the local URL. */
export async function adminRoutes(ctx, req, res, url) {
  const path = url.pathname,
    method = req.method;
  const {
    store,
    engine,
    connections,
    runtime,
    onShutdown,
    startupSettings,
    onRestart,
    restart,
    credits,
    loadDefaults,
    publicOrigin,
    installedExtensions,
    players,
    invites,
    commands,
    pairings,
    wave,
    idempotent,
    admin,
    voices,
    changed,
  } = ctx;
  if (path.startsWith("/api/v1/admin/")) {
    admin(req);
    if (path === "/api/v1/admin/extensions" && method === "GET")
      return json(
        res,
        200,
        [...installedExtensions.values()].map(({ id, title }) => ({
          id,
          title,
          script: `/web/ext/${id}/admin.js`,
        })),
      );
    const extensionRoute = path.match(
      /^\/api\/v1\/admin\/ext\/([a-z0-9-]+)\/(.*)$/,
    );
    if (extensionRoute) {
      const extension = installedExtensions.get(extensionRoute[1]);
      check(extension, "拡張がありません", 404);
      const result = await extension.admin({
        method,
        path: extensionRoute[2],
        query: url.searchParams,
        body: ["POST", "PUT", "PATCH"].includes(method)
          ? await body(req)
          : undefined,
      });
      return json(res, result.status ?? 200, result.data);
    }
    if (path === "/api/v1/admin/config" && method === "GET")
      return json(res, 200, store.config);
    if (path === "/api/v1/admin/chat-voice-registration" && method === "PUT") {
      const b = await body(req);
      check(
        typeof b.chatVoiceRegistrationEnabled === "boolean",
        "チャットによる登録機能の設定が不正です",
      );
      store.change((c) => {
        store.compare(c.chatVoiceRegistrationEnabled ?? false, b.before);
        c.chatVoiceRegistrationEnabled = b.chatVoiceRegistrationEnabled;
        if (!b.chatVoiceRegistrationEnabled)
          store.voiceCommands.cancel(
            null,
            "チャット登録機能がOFFになったため中断しました",
          );
      });
      engine.chatVoices.reconcile();
      engine.notify("characters.changed");
      return json(res, 200, {
        chatVoiceRegistrationEnabled: store.config.chatVoiceRegistrationEnabled,
      });
    }
    if (path === "/api/v1/admin/delivery" && method === "PUT") {
      const b = await body(req);
      check(
        DELIVERY_CAPTION_MODES.includes(b.deliveryCaptionMode),
        "感情・演技の指定方法が不正です",
      );
      store.change((c) => {
        store.compare(c.deliveryCaptionMode ?? "append", b.before);
        c.deliveryCaptionMode = b.deliveryCaptionMode;
      });
      return json(res, 200, {
        deliveryCaptionMode: store.config.deliveryCaptionMode,
      });
    }
    if (path === "/api/v1/admin/provider" && method === "PUT") {
      check(
        runtime?.settings.active.mode !== "bundled",
        "内蔵TTSの使用中は外部接続先を変更できません",
        409,
      );
      const b = await body(req);
      store.change((c) => {
        store.compare(c.provider, b.before);
        c.provider.baseUrl = b.baseUrl;
        c.provider.type = b.type ?? c.provider.type;
        store.voiceCommands.cancel(null, "TTS接続先の変更で中断しました");
      });
      engine.chatVoices.reconcile();
      engine.notify("characters.changed");
      return json(res, 200, store.config.provider);
    }
    if (path === "/api/v1/admin/splitting" && method === "PUT") {
      const b = await body(req);
      check(
        Number.isInteger(b.sentenceSplitThresholdChars),
        "文の分割しきい値は1～500文字です",
      );
      store.change((c) => {
        store.compare(
          c.sentenceSplitThresholdChars ??
            DEFAULT_SENTENCE_SPLIT_THRESHOLD_CHARS,
          b.before,
        );
        c.sentenceSplitThresholdChars = b.sentenceSplitThresholdChars;
      });
      return json(res, 200, {
        sentenceSplitThresholdChars: store.config.sentenceSplitThresholdChars,
      });
    }
    if (path === "/api/v1/admin/audio-format" && method === "PUT") {
      const b = await body(req);
      check(
        Object.hasOwn(AUDIO_FORMATS, b.audioFormat),
        "音声の配信形式が不正です",
      );
      store.change((c) => {
        store.compare(c.audioFormat ?? DEFAULT_AUDIO_FORMAT, b.before);
        c.audioFormat = b.audioFormat;
      });
      return json(res, 200, { audioFormat: store.config.audioFormat });
    }
    if (path === "/api/v1/admin/playback" && method === "PUT") {
      const b = await body(req);
      check(Number.isInteger(b.sentencePauseMs), "文の間は0～3000ミリ秒です");
      store.change((c) => {
        store.compare(c.sentencePauseMs ?? DEFAULT_SENTENCE_PAUSE_MS, b.before);
        c.sentencePauseMs = b.sentencePauseMs;
      });
      return json(res, 200, {
        sentencePauseMs: store.config.sentencePauseMs,
      });
    }
    if (path === "/api/v1/admin/subtitles" && method === "PUT") {
      const b = await body(req);
      check(typeof b.publishTextToPlayers === "boolean", "字幕設定が不正です");
      store.change((c) => {
        store.compare(c.publishTextToPlayers, b.before);
        c.publishTextToPlayers = b.publishTextToPlayers;
        if (b.before !== b.publishTextToPlayers)
          store.chat.advanceGenerationInside();
      });
      engine.chatPolicyChanged();
      return json(res, 200, {
        publishTextToPlayers: store.config.publishTextToPlayers,
      });
    }
    if (path === "/api/v1/admin/chat-history" && method === "DELETE") {
      const result = store.chat.clear();
      engine.chatPolicyChanged(true);
      return json(res, 200, result);
    }
    if (path === "/api/v1/admin/pairings") {
      if (method === "GET")
        return json(
          res,
          200,
          [...pairings.values()]
            .filter((p) => !p.token && !p.rejected && p.expires > Date.now())
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
    if (path === "/api/v1/admin/credits" && method === "GET")
      return json(res, 200, credits);
    if (runtime && path.startsWith("/api/v1/admin/models")) {
      try {
        if (path === "/api/v1/admin/models" && method === "GET")
          return json(res, 200, await runtime.models.list());
        if (path === "/api/v1/admin/models/dir" && method === "PUT") {
          await runtime.models.setDir((await body(req))?.dir);
          return json(res, 200, await runtime.models.list());
        }
        if (path === "/api/v1/admin/models/pull" && method === "POST")
          return json(
            res,
            202,
            await runtime.models.pull((await body(req))?.choice),
          );
        if (path === "/api/v1/admin/models/pull" && method === "DELETE") {
          await runtime.models.cancel();
          return json(res, 200, { ok: true });
        }
      } catch (e) {
        throw new HttpError(e.status ?? 500, e.message);
      }
    }
    if (runtime && path === "/api/v1/admin/runtime") {
      if (method === "PUT") {
        try {
          runtime.settings.save(await body(req));
        } catch (e) {
          throw new HttpError(400, e.message);
        }
      } else check(method === "GET", "許可されていない操作です", 405);
      return json(res, 200, {
        ...runtime.snapshot(),
        transcription: ctx.transcripts?.snapshot() ?? null,
      });
    }
    if (startupSettings && path === "/api/v1/admin/startup") {
      if (method === "GET") return json(res, 200, startupSettings());
      if (onRestart && method === "PUT")
        return json(res, 202, await restart("save", await body(req)));
      if (onRestart && method === "DELETE")
        return json(res, 202, await restart("reset"));
      throw new HttpError(405, "許可されていない操作です");
    }
    if (onRestart && path === "/api/v1/admin/restart" && method === "POST")
      return json(res, 202, await restart("restart"));
    if (onShutdown && path === "/api/v1/admin/shutdown" && method === "POST") {
      json(res, 200, { ok: true });
      setImmediate(() => onShutdown());
      return;
    }
    if (
      path === "/api/v1/admin/reference-voices/resolve" &&
      method === "POST"
    ) {
      const b = await body(req);
      const provider = structuredClone(engine.config.provider);
      const before = () => store.compare(engine.config.provider, b.before);
      before();
      check(
        ["retry", "adopt", "forget"].includes(b.action),
        "参照音声の操作が不正です",
      );
      if (b.action === "adopt") {
        check(b.confirm === true, "同じ音声であることの確認が必要です");
        await engine.references.adopt(provider, b.id, b.sha256, before);
      } else if (b.action === "forget") {
        check(b.confirm === true, "管理対象から外す確認が必要です");
        check(
          runtime?.status !== "starting",
          "内蔵TTSの起動が終わってから再試行してください",
          409,
        );
        await engine.references.forget(b.id, b.sha256, before);
      } else await engine.references.prepare(provider);
      return json(res, 200, {
        issues: engine.references.diagnostics(provider),
      });
    }
    if (path === "/api/v1/admin/diagnostics" && method === "GET") {
      let tts;
      try {
        if (runtime?.settings.active.mode === "bundled")
          tts = { status: runtime.status, error: runtime.error };
        else if (engine.config.provider.type === "mock")
          tts = { status: "mock" };
        else {
          const r = await fetch(`${engine.config.provider.baseUrl}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          check(r.ok, "TTS診断失敗", 502);
          const h = await r.json();
          if (engine.config.provider.type === "speech") {
            const model = await speechModel(engine.config.provider);
            tts = { status: h.status, model: model.id };
          } else tts = { status: h.status, model: h.model, runtime: h.runtime };
        }
      } catch (e) {
        tts = { status: "unreachable", error: e.message };
      }
      return json(res, 200, {
        ...engine.metadata(),
        ...(runtime
          ? {
              runtime: {
                ...runtime.snapshot(),
                transcription: ctx.transcripts?.snapshot() ?? null,
              },
            }
          : {}),
        canShutdown: Boolean(onShutdown),
        canRestart: Boolean(onRestart),
        accepting: engine.accepting,
        tts,
        degraded: engine.degraded,
        lastError: engine.lastError,
        voiceCommands: store.voiceCommands.diagnostics(),
        referenceVoices: engine.references.diagnostics(engine.config.provider),
        referenceProvider: engine.config.provider,
        referenceProgress: engine.references.progress(engine.config.provider),
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
        typeof b.commandId === "string" && /^[\w-]{1,120}$/.test(b.commandId),
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
        ctx.session.currentInvite = null;
        players.clear();
        for (const ws of ctx.wss.clients) ws.close(1000, "session ended");
      } else if (b.command === "recover-provider") {
        engine.recover();
      } else if (b.command === "release-collector") engine.collectors.clear();
      else if (b.command === "reset-settings") {
        check(b.confirm === true, "初期化の確認が必要です");
        engine.reset(false, "設定リセットで中断しました");
        const before = store.config;
        store.resetDefaults(loadDefaults?.());
        changed(before);
      } else if (b.command === "revoke-collectors") {
        store.revokeCollectors();
        engine.collectors.clear();
        pairings.clear();
      } else if (b.command === "invite" || b.command === "renew-invite") {
        if (
          b.command === "invite" &&
          ctx.session.currentInvite?.expires > Date.now()
        )
          result = ctx.session.currentInvite;
        else {
          ctx.session.invitationGeneration++;
          invites.clear();
          const token = randomBytes(32).toString("hex");
          invites.set(hash(token), {
            expires: Date.now() + 3600000,
            sessionId: engine.sessionId,
            generation: ctx.session.invitationGeneration,
          });
          result = {
            url: `${publicOrigin || ctx.localOrigin}/player/#invite=${token}`,
            localUrl: `${ctx.localOrigin}/player/#invite=${token}`,
            expires: Date.now() + 3600000,
          };
          ctx.session.currentInvite = result;
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
}
