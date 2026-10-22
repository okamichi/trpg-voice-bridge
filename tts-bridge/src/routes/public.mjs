import { readAsset } from "../runtime/assets.mjs";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { check, hash } from "../contracts.mjs";
import { json, body, equal } from "../http-util.mjs";

/** Health, static files, the admin login and Collector pairing. Returns true when handled. */
export async function publicRoutes(ctx, req, res, url) {
  const path = url.pathname,
    method = req.method;
  const { store, installedExtensions, download, pairings, bootAccess, origin } =
    ctx;
  if (path === "/healthz" && method === "GET")
    return json(res, 200, { status: "ok" });
  const extensionScript = path.match(/^\/web\/ext\/([a-z0-9-]+)\/admin\.js$/);
  if (method === "GET" && extensionScript) {
    origin(req, true);
    const extension = installedExtensions.get(extensionScript[1]);
    check(extension, "拡張がありません", 404);
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
    });
    return res.end(
      extension.adminAsset
        ? readAsset(extension.adminAsset)
        : readFileSync(extension.adminScript),
    );
  }
  if (method === "GET" && path === "/downloads/chatter.zip") {
    check(download, "ChatterのZIPを作成できませんでした", 503);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${download.filename}"`,
      "Content-Length": download.content.length,
    });
    return res.end(download.content);
  }
  const staticFiles = {
    "/player/": ["player.html", "text/html"],
    "/admin/": ["admin.html", "text/html"],
    "/web/style.css": ["style.css", "text/css"],
    "/web/characters.js": ["characters.js", "text/javascript"],
    "/web/player.js": ["player.js", "text/javascript"],
    "/web/admin.js": ["admin.js", "text/javascript"],
    "/web/playback.js": ["playback.js", "text/javascript"],
    "/web/uuid.js": ["uuid.js", "text/javascript"],
    "/web/bridge-client.js": ["bridge-client.js", "text/javascript"],
    "/web/chat-history.js": ["chat-history.js", "text/javascript"],
    "/web/chat-view.js": ["chat-view.js", "text/javascript"],
  };
  if (method === "GET" && staticFiles[path]) {
    if (path === "/admin/" || path === "/web/admin.js") origin(req, true);
    const [f, mime] = staticFiles[path];
    res.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` });
    return res.end(readAsset(`web/${f}`));
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
      req.headers.host === new URL(ctx.localOrigin).host,
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
    check(pending.origin === (req.headers.origin ?? ""), "異なる拡張です", 403);
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
}
