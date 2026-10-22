import { check, sourceKey } from "../contracts.mjs";
import { json, body } from "../http-util.mjs";

/** Collector extension connection and VTT events. Returns true when handled. */
export async function collectorRoutes(ctx, req, res, url) {
  const path = url.pathname,
    method = req.method;
  const { store, engine, collector } = ctx;
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
      ["/api/v1/collectors/connect", "/api/v1/collectors/heartbeat"].includes(
        path,
      ),
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
      !store.config.sources.some((s) => sourceKey(s) === sourceKey(b.source))
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
}
