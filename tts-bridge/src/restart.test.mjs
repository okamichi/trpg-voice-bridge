import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge } from "./runtime/launcher.mjs";
import { StartupSettings, launchOverrides } from "./runtime/startup.mjs";
import { initialConfig } from "./store.mjs";

async function unusedPort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

async function setup(t, { env = {}, fail, prepare } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-restart-"));
  const port = await unusedPort();
  const startup = new StartupSettings({
    file: join(dir, "startup.json"),
    defaults: {
      dataDir: join(dir, "data"),
      host: "127.0.0.1",
      port,
      publicOrigin: "",
    },
    ...launchOverrides(env),
  });
  const boots = [];
  const handle = await startBridge({
    startup,
    prepare,
    boot: (active) => {
      boots.push(active);
      if (fail?.(active)) throw Error("boot failed");
      const initial = initialConfig({});
      initial.provider.type = "mock";
      return { initial, localOrigin: `http://127.0.0.1:${active.port}` };
    },
  });
  t.after(async () => {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, port, startup, handle, boots };
}

async function admin(handle, path, method = "GET", body) {
  const app = handle.app;
  const response = await fetch(`${app.localOrigin}/api/v1/admin/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${app.store.secrets.admin}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}

async function result(origin, id) {
  for (let i = 0; i < 200; i++) {
    try {
      const response = await fetch(`${origin}/api/v1/restart-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.state !== "restarting") return data;
      }
    } catch {
      /* Bridge is between two starts. */
    }
    await delay(25);
  }
  throw Error("restart did not finish");
}

test("a port change restarts on the new port and the old one relays the result", async (t) => {
  const { dir, port, startup, handle } = await setup(t);
  const before = handle.app;
  const next = await unusedPort();
  const { status, data } = await admin(handle, "startup", "PUT", {
    port: next,
  });
  assert.equal(status, 202);
  assert.match(data.restartId, /^[a-f0-9]{64}$/);
  const done = await result(`http://127.0.0.1:${port}`, data.restartId);
  assert.equal(done.state, "done");
  assert.match(
    done.adminUrl,
    new RegExp(`^http://127\\.0\\.0\\.1:${next}/admin/#access=[a-f0-9]{64}$`),
  );
  assert.notEqual(handle.app, before);
  assert.throws(() => before.store.config && before.store.maxSeq());
  assert.equal((await fetch(`http://127.0.0.1:${next}/healthz`)).status, 200);
  assert.equal(
    JSON.parse(readFileSync(join(dir, "startup.json"), "utf8")).port,
    next,
  );
  assert.equal(startup.active.port, next);
  // The relay answers only the result, and only for its own ID.
  const other = await fetch(`http://127.0.0.1:${port}/api/v1/admin/config`);
  assert.equal(other.status, 503);
  const wrong = await fetch(`http://127.0.0.1:${port}/api/v1/restart-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "0".repeat(64) }),
  });
  assert.equal(wrong.status, 404);
  const foreign = await fetch(
    `http://127.0.0.1:${port}/api/v1/restart-status`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ id: data.restartId }),
    },
  );
  assert.equal(foreign.status, 503);
});

test("a new data directory on the same port gets its own store and admin secret", async (t) => {
  const { dir, port, handle } = await setup(t);
  const secret = handle.app.store.secrets.admin;
  const dataDir = join(dir, "table-b");
  const { data } = await admin(handle, "startup", "PUT", { dataDir });
  const done = await result(`http://127.0.0.1:${port}`, data.restartId);
  assert.equal(done.state, "done");
  assert.equal(handle.app.store.dir, dataDir);
  assert.notEqual(handle.app.store.secrets.admin, secret);
  assert.ok(existsSync(join(dataDir, "bridge.sqlite")));
  // The old cookie no longer works; the new link carries a fresh access.
  const config = await fetch(`http://127.0.0.1:${port}/api/v1/admin/config`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(config.status, 401);
  const access = new URL(done.adminUrl).hash.match(/access=([a-f0-9]+)/)[1];
  const login = await fetch(`http://127.0.0.1:${port}/api/v1/admin-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access }),
  });
  assert.equal(login.status, 200);
});

test("a failed start rolls back to the previous settings and saves nothing", async (t) => {
  const next = await unusedPort();
  const { dir, port, startup, handle, boots } = await setup(t, {
    fail: (active) => active.port === next,
  });
  const { data } = await admin(handle, "startup", "PUT", { port: next });
  const done = await result(`http://127.0.0.1:${port}`, data.restartId);
  assert.equal(done.state, "rolledBack");
  assert.match(done.error, /元の設定で起動しました/);
  assert.equal(new URL(done.adminUrl).port, String(port));
  assert.deepEqual(
    boots.map((x) => x.port),
    [port, next, port],
  );
  assert.equal(existsSync(join(dir, "startup.json")), false);
  assert.equal(startup.active.port, port);
  const snapshot = await admin(handle, "startup");
  assert.match(snapshot.data.lastRestart.error, /元の設定で起動しました/);
});

test("refused requests leave Bridge running unchanged", async (t) => {
  const busy = createServer();
  await new Promise((r) => busy.listen(0, "127.0.0.1", r));
  t.after(() => busy.close());
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { handle, startup } = await setup(t, {
    env: { TTS_PUBLIC_ORIGIN: "" },
    prepare: () => held,
  });
  const before = handle.app;
  const taken = await admin(handle, "startup", "PUT", {
    port: busy.address().port,
  });
  assert.equal(taken.status, 409);
  assert.match(taken.data.error, /使用中/);
  const locked = await admin(handle, "startup", "PUT", {
    publicOrigin: "https://voice.example.com",
  });
  assert.equal(locked.status, 400);
  assert.match(locked.data.error, /環境変数 TTS_PUBLIC_ORIGIN/);
  const invalid = await admin(handle, "startup", "PUT", { port: 0 });
  assert.equal(invalid.status, 400);
  assert.equal(handle.app, before);
  assert.equal(startup.saved, null);
  // A second request while the first one is still being checked.
  const first = admin(handle, "restart", "POST", {});
  await delay(50);
  const second = await admin(handle, "restart", "POST", {});
  assert.equal(second.status, 409);
  assert.match(second.data.error, /再起動中/);
  release();
  const { status, data } = await first;
  assert.equal(status, 202);
  assert.equal(
    (await result(before.localOrigin, data.restartId)).state,
    "done",
  );
});

test("reset removes the settings file and starts with the defaults", async (t) => {
  const { dir, port, startup, handle } = await setup(t);
  const next = await unusedPort();
  let { data } = await admin(handle, "startup", "PUT", { port: next });
  await result(`http://127.0.0.1:${port}`, data.restartId);
  assert.ok(existsSync(join(dir, "startup.json")));
  let status;
  ({ status, data } = await admin(handle, "startup", "DELETE"));
  // The old port is free again even though its relay was still open.
  assert.equal(status, 202);
  const done = await result(`http://127.0.0.1:${next}`, data.restartId);
  assert.equal(done.state, "done");
  assert.equal(existsSync(join(dir, "startup.json")), false);
  assert.equal(startup.active.port, port);
  assert.equal(new URL(handle.app.localOrigin).port, String(port));
});

test("repeated restarts keep one set of signal handlers", async (t) => {
  const { handle } = await setup(t);
  const listeners = process.listenerCount("SIGINT");
  for (let i = 0; i < 5; i++) {
    const { status, data } = await admin(handle, "restart", "POST", {});
    assert.equal(status, 202);
    assert.equal(
      (await result(handle.app.localOrigin, data.restartId)).state,
      "done",
    );
  }
  assert.equal(process.listenerCount("SIGINT"), listeners);
  const diagnostics = await admin(handle, "diagnostics");
  assert.equal(diagnostics.data.canRestart, true);
});
