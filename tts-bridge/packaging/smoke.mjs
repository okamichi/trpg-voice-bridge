import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { initialConfig } from "../src/store.mjs";
import { checkProjectVersion } from "./version.mjs";

const version = checkProjectVersion();

const source = resolve(
  process.argv[2] ??
    fileURLToPath(
      new URL(
        `../dist/trpg-voice-bridge-${version}-${process.platform}-${process.arch}.zip`,
        import.meta.url,
      ),
    ),
);
const temporary = mkdtempSync(join(tmpdir(), "bridge-package-"));
const packageDir = join(temporary, "日本語 package");
let dataDir = join(temporary, "設定 data");
const cwd = join(temporary, "別の cwd");
mkdirSync(cwd);
if (source.endsWith(".zip")) {
  const unpacked = join(temporary, "unpacked");
  mkdirSync(unpacked);
  if (process.platform === "darwin")
    execFileSync("ditto", ["-x", "-k", source, unpacked]);
  else
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:BRIDGE_PACKAGE_ZIP -DestinationPath $env:BRIDGE_PACKAGE_DEST",
      ],
      {
        env: {
          ...process.env,
          BRIDGE_PACKAGE_ZIP: source,
          BRIDGE_PACKAGE_DEST: unpacked,
        },
      },
    );
  cpSync(join(unpacked, "TRPG-Voice-Bridge"), packageDir, { recursive: true });
} else cpSync(source, packageDir, { recursive: true });
const exe = join(
  packageDir,
  process.platform === "win32" ? "trpg-voice-bridge.exe" : "trpg-voice-bridge",
);
// The product must not need Node, npm, NODE_PATH, or development configuration.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(TTS_|NODE_|NAPI_RS_|DISCORD_)/.test(key),
  ),
);
env.PATH = "";
let child,
  output = "",
  failure = "",
  secret;
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const port = await unusedPort();
const base = `http://127.0.0.1:${port}`;
async function start(extra = []) {
  child = spawn(
    exe,
    ["--no-browser", "--data-dir", dataDir, "--port", String(port), ...extra],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (s) => (output += s));
  child.stderr.on("data", (s) => (failure += s));
  child.on("error", (e) => (failure += e.message));
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null, `process exited: ${failure}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await delay(100);
  }
  throw Error(`startup timed out: ${failure}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  // Windows does not deliver POSIX SIGTERM; exercise the authenticated normal
  // shutdown route on both platforms instead of forcibly terminating Bridge.
  const authDb = new DatabaseSync(join(dataDir, "bridge.sqlite"), {
    readOnly: true,
  });
  const shutdownSecret = JSON.parse(
    authDb.prepare("SELECT data FROM auth WHERE key='secrets'").get().data,
  ).admin;
  authDb.close();
  await request("/api/v1/admin/shutdown", "POST", {}, shutdownSecret);
  for (
    let i = 0;
    i < 100 && current.exitCode === null && current.signalCode === null;
    i++
  )
    await delay(50);
  if (current.exitCode === null && current.signalCode === null) {
    current.kill("SIGKILL");
    throw Error("shutdown timed out");
  }
  assert.equal(current.exitCode, 0);
  child = undefined;
}
async function request(
  path,
  method = "GET",
  body,
  token = secret,
  expected = 200,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected, `${method} ${path}`);
  return response.json();
}
try {
  assert.equal(
    execFileSync(exe, ["--version"], { cwd, env, encoding: "utf8" }).trim(),
    version,
  );
  assert.equal(
    JSON.parse(readFileSync(join(packageDir, "build-info.json"))).version,
    version,
  );
  assert.equal(
    JSON.parse(readFileSync(join(packageDir, "collector/manifest.json")))
      .version,
    version,
  );
  assert.match(
    execFileSync(
      join(
        packageDir,
        "runtime/speech",
        process.platform === "win32" ? "speech.exe" : "speech",
      ),
      ["--version"],
      { cwd, env, encoding: "utf8" },
    ),
    /speech\.cpp/,
  );
  const diagnostics = JSON.parse(
    execFileSync(exe, ["--self-test"], { cwd, env, encoding: "utf8" }),
  );
  assert.equal(diagnostics.sqlite, "ok");
  assert.equal(diagnostics.discord, "ok");
  assert.ok(diagnostics.opusPackets > 0);
  assert.match(
    execFileSync(exe, ["--help"], { cwd, env, encoding: "utf8" }),
    /--data-dir/,
  );
  await start();
  for (const path of [
    "/admin/",
    "/player/",
    "/web/style.css",
    "/web/admin.js",
    "/web/player.js",
    "/web/playback.js",
    "/web/characters.js",
    "/web/uuid.js",
    "/web/ext/discord/admin.js",
  ]) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200, path);
    assert.ok((await r.text()).length > 10, path);
  }
  assert.ok(
    JSON.parse(readFileSync(join(packageDir, "collector/manifest.json")))
      .manifest_version,
  );
  const db = new DatabaseSync(join(dataDir, "bridge.sqlite"), {
    readOnly: true,
  });
  secret = JSON.parse(
    db.prepare("SELECT data FROM auth WHERE key='secrets'").get().data,
  ).admin;
  for (const table of ["characters", "voices", "events"])
    assert.equal(
      db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count,
      0,
    );
  assert.deepEqual(
    db
      .prepare("SELECT key FROM auth ORDER BY key")
      .all()
      .map((row) => row.key),
    ["secrets"],
  );
  db.close();
  await request("/api/v1/admin/config", "GET", undefined, "", 401);
  const initial = await request("/api/v1/admin/config");
  assert.deepEqual(initial, initialConfig({}));
  const discord = await request("/api/v1/admin/ext/discord/status");
  assert.equal(discord.installed, true);
  assert.equal(discord.tokenSet, false);
  assert.equal(discord.guildId, "");
  assert.equal(discord.channelId, "");
  assert.equal(discord.enabled, false);
  assert.equal(discord.autoConnect, false);
  const invite = await request("/api/v1/admin/commands", "POST", {
    command: "invite",
    commandId: randomUUID(),
  });
  const joined = await fetch(`${base}/api/v1/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invite: new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
        "invite",
      ),
    }),
  });
  assert.equal(joined.status, 200);
  const cookie = joined.headers.get("set-cookie").split(";")[0];
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, {
      origin: base,
      headers: { Cookie: cookie },
    });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(Error("WebSocket timeout"));
    }, 5000);
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ws.once("open", () =>
      ws.send(JSON.stringify({ type: "hello", clientId: "package-player" })),
    );
    ws.on("message", (data) => {
      if (JSON.parse(data).type === "state.snapshot") {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });
  });
  const newUrl = "http://127.0.0.1:18088";
  await request("/api/v1/admin/provider", "PUT", {
    before: initial.provider,
    baseUrl: newUrl,
  });
  const key = randomBytes(32).toString("hex");
  await request("/api/v1/pairings", "POST", { key }, "");
  const [pending] = await request("/api/v1/admin/pairings");
  await request("/api/v1/admin/pairings", "POST", {
    id: pending.id,
    approve: true,
  });
  const { token } = await request("/api/v1/pairings", "POST", { key }, "");
  assert.ok(token);
  const connect = {
    collectorId: "package-smoke",
    source: { adapter: "fixture", instanceId: "package", contextId: "room" },
  };
  await request("/api/v1/collectors/connect", "POST", connect, token);
  await stop();
  const seed = new DatabaseSync(join(dataDir, "bridge.sqlite"));
  seed.prepare("INSERT INTO characters (id, data) VALUES (?, ?)").run(
    "saved-character",
    JSON.stringify({
      id: "saved-character",
      displayName: "保存されたキャラ",
      enabled: true,
      voiceProfileId: null,
      bindings: [],
    }),
  );
  seed.close();
  await start();
  const restored = await request("/api/v1/admin/config");
  assert.equal(restored.provider.baseUrl, newUrl);
  assert.equal(restored.characters[0].displayName, "保存されたキャラ");
  await request("/api/v1/collectors/connect", "POST", connect, token);
  await request("/api/v1/admin/commands", "POST", {
    command: "reset-settings",
    commandId: randomUUID(),
    confirm: true,
  });
  const reset = await request("/api/v1/admin/config");
  assert.deepEqual(reset.characters, []);
  assert.equal(reset.provider.baseUrl, newUrl); // Existing reset preserves connection settings.
  await stop();
  assert.doesNotMatch(output + failure, /#access=|Bearer |trpg_admin=/);
  assert.ok(!(output + failure).includes(secret));
  assert.ok(!(output + failure).includes(token));
  // A separate installation must generate its own secrets, not restore a key
  // embedded in the executable or copied from the developer's database.
  const originalDataDir = dataDir;
  dataDir = join(temporary, "別の初期DB");
  await start();
  const freshDb = new DatabaseSync(join(dataDir, "bridge.sqlite"), {
    readOnly: true,
  });
  const freshSecrets = JSON.parse(
    freshDb.prepare("SELECT data FROM auth WHERE key='secrets'").get().data,
  );
  freshDb.close();
  assert.ok(
    freshSecrets.admin !== secret,
    "fresh installation must create a new admin secret",
  );
  await request("/api/v1/admin/config", "GET", undefined, secret, 401);
  assert.deepEqual(
    await request("/api/v1/admin/config", "GET", undefined, freshSecrets.admin),
    initialConfig({}),
  );
  await stop();
  dataDir = originalDataDir;
  // Model failure must leave the UI available and preserve the external URL.
  await start(["--tts", "bundled"]);
  await request("/api/v1/admin/runtime", "GET", undefined, "", 401);
  const runtime = await request("/api/v1/admin/runtime");
  assert.equal(runtime.active.mode, "bundled");
  assert.equal(runtime.saved.mode, "external");
  assert.equal(runtime.status, "error");
  assert.equal(
    (await request("/api/v1/admin/config")).provider.baseUrl,
    newUrl,
  );
  await request(
    "/api/v1/admin/provider",
    "PUT",
    { before: reset.provider, baseUrl: newUrl },
    secret,
    409,
  );
  await request(
    "/api/v1/admin/runtime",
    "PUT",
    { mode: "bundled", model: "relative.gguf", ttsPort: 18088 },
    secret,
    400,
  );
  await request("/api/v1/admin/runtime", "PUT", {
    mode: "external",
    model: "",
    ttsPort: 18089,
  });
  const duplicate = spawn(
    exe,
    [
      "--no-browser",
      "--data-dir",
      dataDir,
      "--port",
      String(await unusedPort()),
    ],
    { cwd, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let duplicateError = "";
  duplicate.stderr.on("data", (s) => (duplicateError += s));
  const duplicateCode = await new Promise((resolve) =>
    duplicate.once("close", resolve),
  );
  assert.equal(duplicateCode, 1);
  assert.match(duplicateError, /同じ保存先のBridge/);
  assert.ok((await fetch(`${base}/healthz`)).ok);
  // A busy Bridge port is named instead of the generic startup failure.
  const busyPort = spawn(
    exe,
    [
      "--no-browser",
      "--data-dir",
      join(temporary, "ポート競合 data"),
      "--port",
      String(port),
    ],
    { cwd, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let busyPortError = "";
  busyPort.stderr.on("data", (s) => (busyPortError += s));
  assert.equal(
    await new Promise((resolve) => busyPort.once("close", resolve)),
    1,
  );
  assert.match(busyPortError, new RegExp(`ポート${port}は使用中`));
  assert.ok((await fetch(`${base}/healthz`)).ok);
  await stop();
  await start();
  assert.equal(
    (await request("/api/v1/admin/runtime")).active.mode,
    "external",
  );
  assert.equal((await request("/api/v1/admin/runtime")).active.ttsPort, 18089);
  await stop();
  // A damaged runtime must be diagnosed, not silently reported as installed.
  const moduleDir = join(packageDir, "runtime/discord/node_modules/opusscript");
  renameSync(moduleDir, `${moduleDir}.missing`);
  assert.throws(() =>
    execFileSync(exe, ["--self-test"], { cwd, env, stdio: "pipe" }),
  );
  await start();
  assert.equal(
    (await request("/api/v1/admin/ext/discord/status")).installed,
    false,
  );
  await stop();
  console.log(
    "PASS: isolated SEA, clean initial DB/config, fresh installation secrets, Unicode paths, SQLite restart/reset, assets, Player WebSocket, Collector auth, Discord/Opus, runtime settings/lock/model failure, missing runtime diagnosis, secret-free redirected logs",
  );
} finally {
  await stop();
  rmSync(temporary, { recursive: true, force: true });
}
