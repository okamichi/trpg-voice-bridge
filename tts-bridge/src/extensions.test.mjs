import test from "node:test";
import { request } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "./http.mjs";
import { mockWav } from "./provider.mjs";

test("extension routes authenticate, limit bodies, protect scripts and close before engine", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-ext-"));
  const script = join(dir, "admin.js");
  writeFileSync(script, "export const mount = () => {};");
  const requests = [],
    shutdown = [];
  let instance;
  const app = createApp({
    dataDir: dir,
    localOrigin: "http://127.0.0.1:0",
    publicOrigin: "https://players.example",
    extensions: [
      ({ engine }) => {
        instance = engine;
        return {
          id: "fake",
          title: "Test extension",
          adminScript: pathToFileURL(script),
          admin: async (request) => {
            requests.push(request);
            return { status: 201, data: { ok: true } };
          },
          close: async () => {
            assert.equal(engine.closed, false);
            shutdown.push("extension");
          },
        };
      },
    ],
  });
  const closeEngine = app.engine.close.bind(app.engine);
  app.engine.close = () => {
    shutdown.push("engine");
    closeEngine();
  };
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const headers = {
    Host: "127.0.0.1:0",
    Authorization: `Bearer ${app.store.secrets.admin}`,
    "Content-Type": "application/json",
  };
  const call = (path, options = {}) =>
    fetch(base + path, { headers, ...options });
  for (const path of [
    "/api/v1/admin/extensions",
    "/api/v1/admin/ext/fake/status",
  ]) {
    for (const unauthorized of [
      { Host: "127.0.0.1:0" },
      { Host: "127.0.0.1:0", Authorization: "Bearer collector" },
      { Host: "127.0.0.1:0", Cookie: "trpg_player=player" },
    ])
      assert.equal((await call(path, { headers: unauthorized })).status, 401);
    assert.equal(
      (
        await call(path, {
          headers: { ...headers, Origin: "https://players.example" },
        })
      ).status,
      403,
    );
  }
  assert.deepEqual(await (await call("/api/v1/admin/extensions")).json(), [
    { id: "fake", title: "Test extension", script: "/web/ext/fake/admin.js" },
  ]);
  const response = await call("/api/v1/admin/ext/fake/settings?x=one", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(response.status, 201);
  assert.equal(requests[0].query.get("x"), "one");
  assert.deepEqual(requests[0].body, { enabled: true });
  assert.equal(requests[0].path, "settings");
  assert.equal(
    (
      await call("/api/v1/admin/ext/fake/settings", {
        method: "PUT",
        body: JSON.stringify({ big: "a".repeat(17000) }),
      })
    ).status,
    413,
  );
  assert.equal((await call("/api/v1/admin/ext/missing/status")).status, 404);
  assert.equal((await call("/web/ext/fake/admin.js")).status, 200);
  assert.equal((await call("/web/ext/missing/admin.js")).status, 404);
  assert.equal(
    (
      await call("/web/ext/fake/admin.js", {
        headers: { ...headers, Origin: "https://players.example" },
      })
    ).status,
    403,
  );
  const remoteHostStatus = await new Promise((resolve, reject) => {
    const req = request(
      base + "/web/ext/fake/admin.js",
      { headers: { Host: "players.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(remoteHostStatus, 403);
  const audio = instance.saveAudio(mockWav());
  assert.equal(instance.audioFile(audio.id), audio.file);
  audio.retainUntil = 0;
  assert.equal(instance.audioFile(audio.id), null);
  assert.equal(instance.audioFile("missing"), null);
  // Exercise explicit close and inspect ordering without relying on a swallowed rejection.
  await app.close();
  assert.deepEqual(shutdown, ["extension", "engine"]);
  // Avoid closing the SQLite store a second time in the cleanup hook.
  app.close = async () => {};
});
