import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createApp, securityHeaders } from "../http.mjs";
import { exposed } from "./settings.mjs";
import { checkDataDir, probePort } from "./startup.mjs";
import { configSchema } from "../contracts.mjs";

// How long a restart's result stays readable for the admin page.
const RESULT_TTL = 120000;

const busy = (message) => Object.assign(exposed(message), { status: 409 });

// Library errors may carry secrets; only fixed messages reach the user.
const reason = (error) =>
  error?.expose
    ? error.message
    : error?.code === "EADDRINUSE"
      ? `Bridgeのポート${error.port ?? ""}は使用中です`
      : "Bridgeを起動できませんでした";

// Runs Bridge and restarts it inside this process, so a terminal, npm and
// Ctrl+C stay attached. boot(active, prepared) returns createApp options plus
// onClose for every start; dataDir and publicOrigin come from the settings.
// Defaults are validated before resource acquisition or stopping the old app.
// Keep that snapshot for launch and the previous snapshot for rollback.
export async function startBridge({
  startup,
  boot,
  prepare,
  loadDefaults,
  onListening,
}) {
  let current, pending, restarting, closing, status;
  const relays = new Set();

  async function readDefaults() {
    if (!loadDefaults) return undefined;
    try {
      return structuredClone(configSchema(await loadDefaults()));
    } catch {
      throw exposed(
        "設定ファイルを読み込めません。内容と読み取り権限を確認してください",
      );
    }
  }

  async function launch(active, prepared, initial) {
    const options = {
      ...(await boot(active, prepared)),
      ...(loadDefaults ? { initial, loadDefaults } : {}),
    };
    let app;
    try {
      app = createApp({
        dataDir: active.dataDir,
        publicOrigin: active.publicOrigin,
        ...options,
        onShutdown: () => signal(),
        startupSettings: () => startup.snapshot(),
        onRestart: request,
        restartStatus: lookup,
      });
    } catch (e) {
      await options.onClose?.();
      throw e;
    }
    app.engine.on("notification", (message) => {
      console.log(
        JSON.stringify({
          time: new Date().toISOString(),
          type: message.type,
          roomId: message.roomId,
          orderId: message.orderId,
          orderSeq: message.orderSeq,
          status: message.status,
          playbackEpoch: message.playbackEpoch,
        }),
      );
    });
    if (options.runtime) options.runtime.onFatal = signal;
    const instance = { app, options, active };
    try {
      await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(active.port, active.host, () => {
          app.server.off("error", reject);
          resolve();
        });
      });
    } catch (e) {
      await close(instance);
      throw e;
    }
    return instance;
  }
  const close = (instance) =>
    instance.app.close().finally(() => instance.options.onClose?.());

  const stop = () =>
    (closing ??= (async () => {
      for (const name of ["SIGINT", "SIGTERM"]) process.off(name, signal);
      await restarting;
      await Promise.all([...relays].map((relay) => relay.close()));
      if (current) await close(current);
    })());
  const signal = () => {
    stop().then(
      () => process.exit(process.exitCode ?? 0),
      () => process.exit(1),
    );
  };

  function lookup(id) {
    if (!status || typeof id !== "string") return null;
    const a = Buffer.from(id),
      b = Buffer.from(status.id);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (!status.result) return { state: "restarting" };
    return Date.now() < status.expires ? status.result : null;
  }

  // Everything that can refuse the request is checked while Bridge still
  // runs, so a refusal leaves it as it was.
  async function request(kind, input) {
    if (pending || closing) throw busy("Bridgeは再起動中です");
    const plan = startup.plan(kind, input);
    pending = true;
    let prepared, initial;
    try {
      initial = await readDefaults();
      // A page asking again has already moved, and the old port may be wanted.
      await Promise.all([...relays].map((relay) => relay.close()));
      const previous = current.active;
      if (plan.active.port !== previous.port)
        await probePort(plan.active.port, plan.active.host);
      if (plan.active.dataDir !== previous.dataDir)
        checkDataDir(plan.active.dataDir);
      prepared = await prepare?.(plan.active, previous);
      if (closing) throw busy("Bridgeは終了中です");
    } catch (e) {
      await prepared?.close();
      pending = false;
      throw e;
    }
    status = { id: randomBytes(32).toString("hex") };
    const entry = status;
    restarting = new Promise((resolve) => setImmediate(resolve))
      .then(() => restart(plan, prepared, entry, initial))
      .catch((error) => {
        console.error(`Bridgeを起動し直せませんでした。${reason(error)}。`);
        process.exitCode = 1;
        signal();
      })
      .finally(() => {
        restarting = undefined;
        pending = false;
      });
    return { restartId: entry.id };
  }

  async function restart(plan, prepared, entry, initial) {
    const previous = current;
    current = undefined;
    await close(previous);
    if (closing) {
      await prepared?.close();
      return;
    }
    // The admin page's CSP keeps it on its own origin, so after a port change
    // it asks the old address for the result.
    const relay =
      plan.active.port !== previous.active.port
        ? await openRelay(previous).catch(() => undefined)
        : undefined;
    let result;
    try {
      current = await launch(plan.active, prepared, initial);
      result = { state: "done" };
      try {
        startup.apply(plan);
      } catch {
        result.error =
          "起動設定を保存できませんでした。次に起動したときは元の設定に戻ります";
      }
      console.log("Bridgeを再起動しました。");
    } catch (e) {
      await relay?.close();
      result = {
        state: "rolledBack",
        error: `新しい起動設定では起動できなかったため、元の設定で起動しました（${reason(e)}）`,
      };
      console.error(result.error);
      current = await launch(
        previous.active,
        undefined,
        previous.options.initial,
      );
    }
    startup.lastRestart = result.error ? { error: result.error } : null;
    entry.result = { ...result, adminUrl: current.app.adminUrl() };
    entry.expires = Date.now() + RESULT_TTL;
    if (relay && result.state === "done")
      setTimeout(() => relay.close(), RESULT_TTL).unref();
    await onListening?.(current.app, { restarted: true });
  }

  // Answers only the restart result on the address Bridge has just left.
  function openRelay(instance) {
    const local = new URL(instance.app.localOrigin);
    const server = createServer(async (req, res) => {
      securityHeaders(res);
      const reply = (code, data) => {
        res.writeHead(code, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(data));
      };
      if (
        req.headers.host !== local.host ||
        (req.headers.origin && req.headers.origin !== local.origin) ||
        req.method !== "POST" ||
        req.url !== "/api/v1/restart-status" ||
        !(req.headers["content-type"] ?? "").startsWith("application/json")
      )
        return reply(503, { error: "Bridgeを再起動しています" });
      try {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) return reply(413, { error: "要求が大きすぎます" });
          chunks.push(chunk);
        }
        const result = lookup(JSON.parse(Buffer.concat(chunks))?.id);
        if (!result) return reply(404, { error: "再起動の情報がありません" });
        return reply(200, result);
      } catch {
        return reply(400, { error: "要求が不正です" });
      }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(instance.active.port, instance.active.host, () => {
        server.off("error", reject);
        const relay = {
          close: () =>
            new Promise((done) => {
              relays.delete(relay);
              server.close(() => done());
              server.closeAllConnections();
            }),
        };
        relays.add(relay);
        resolve(relay);
      });
    });
  }

  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, signal);
  try {
    const initial = await readDefaults();
    current = await launch(startup.active, undefined, initial);
    await onListening?.(current.app, { restarted: false });
  } catch (error) {
    for (const name of ["SIGINT", "SIGTERM"]) process.off(name, signal);
    if (current) await close(current);
    current = undefined;
    throw error;
  }
  return {
    get app() {
      return current?.app;
    },
    stop,
  };
}
