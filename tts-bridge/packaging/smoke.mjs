import { readChatterArchive } from "./chatter-archive.mjs";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute, dirname } from "node:path";
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
  process.argv.slice(2).find((arg) => arg !== "--browser") ??
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
env.PATH =
  process.env.SMOKE_NETWORK === "1" && process.platform === "darwin"
    ? "/usr/bin:/bin"
    : "";
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
let base = `http://127.0.0.1:${port}`;
async function start(extra = [], launch = {}) {
  child = spawn(
    exe,
    launch.args ?? [
      "--no-browser",
      "--data-dir",
      dataDir,
      "--port",
      String(port),
      ...extra,
    ],
    { cwd, env: launch.env ?? env, stdio: ["ignore", "pipe", "pipe"] },
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
  const chatterManifest = JSON.parse(
    readFileSync(join(packageDir, "chatter/manifest.json")),
  );
  assert.equal(chatterManifest.version, version);
  assert.equal(chatterManifest.host_permissions, undefined);
  for (const file of [
    "panel.html",
    "panel.js",
    "background.js",
    "shared/player.js",
    "shared/characters.js",
    "shared/playback.js",
    "shared/bridge-client.js",
    "shared/chat-history.js",
    "shared/chat-view.js",
    "shared/style.css",
    "shared/uuid.js",
  ])
    assert.ok(
      readFileSync(join(packageDir, "chatter", file)).length > 10,
      file,
    );
  assert.ok(!existsSync(join(packageDir, "chatter/build.mjs")));
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
  // The Vulkan build cannot start without a GPU driver's Vulkan loader; its
  // DLL dependencies are checked when it is built.
  if (process.platform === "win32")
    assert.ok(existsSync(join(packageDir, "runtime/speech/speech-vulkan.exe")));
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
    "/web/bridge-client.js",
    "/web/chat-history.js",
    "/web/chat-view.js",
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
  const modelsPath = "/api/v1/admin/models";
  for (const path of [modelsPath, "/api/v1/admin/credits"])
    await request(path, "GET", undefined, "", 401);
  const catalog = await request(modelsPath);
  assert.equal(catalog.models.filter((m) => m.task === "synthesis").length, 8);
  assert.equal(
    catalog.models.filter((m) => m.task === "recognition").length,
    16,
  );
  assert.ok(catalog.models.some((m) => m.choice === "irodori-tts:q8_0"));
  assert.ok(catalog.models.some((m) => m.choice === "irodori-tts-large:q4_k"));
  assert.ok(isAbsolute(catalog.defaultDir));
  const modelDir = join(temporary, "日本語 models");
  const changed = await request(`${modelsPath}/dir`, "PUT", { dir: modelDir });
  assert.equal(changed.dir, modelDir);
  assert.ok(changed.models.every((m) => !m.fetched));
  const credits = await request("/api/v1/admin/credits");
  assert.deepEqual(
    credits.entries.map((entry) => entry.title),
    [
      "TRPG Voice Bridge",
      "speech.cpp",
      "Qwen3-ASR-0.6B",
      "Qwen3-ASR-1.7B",
      "ReazonSpeech v2",
      "Parakeet TDT-CTC 0.6B (ja)",
    ],
  );
  assert.equal(
    credits.entries[0].license,
    readFileSync(join(packageDir, "LICENSE"), "utf8"),
  );
  assert.equal(
    credits.entries[1].license,
    readFileSync(join(packageDir, "runtime/speech/speech.cpp-LICENSE"), "utf8"),
  );
  const buildInfo = JSON.parse(
    readFileSync(join(packageDir, "build-info.json")),
  );
  assert.equal(
    credits.entries[1].url,
    `https://github.com/${buildInfo.speech.speech.repository}/tree/${buildInfo.speech.speech.commit}`,
  );
  if (process.env.SMOKE_NETWORK === "1") {
    const choice = "irodori-tts:q4_k";
    const model = changed.models.find((m) => m.choice === choice);
    async function waitModel(predicate) {
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const state = await request(modelsPath);
        if (state.pull?.status === "error") throw Error(state.pull.error);
        if (predicate(state)) return state;
        await delay(100);
      }
      throw Error("model download timed out");
    }
    const commands = () =>
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
            ],
            { encoding: "utf8" },
          )
        : execFileSync("/bin/ps", ["-axo", "command"], { encoding: "utf8" });
    for (const threshold of [16 * 1024 * 1024, 32 * 1024 * 1024]) {
      const before = (await request(modelsPath)).models.find(
        (m) => m.choice === choice,
      ).partial;
      // Cancellation can overshoot the threshold on a fast connection.
      // Require new bytes on resume, even if the old partial already exceeds 32 MB.
      const target = Math.max(threshold, before + 16 * 1024 * 1024);
      await request(`${modelsPath}/pull`, "POST", { choice }, secret, 202);
      await waitModel((state) => {
        const partial = state.models.find((m) => m.choice === choice).partial;
        assert.ok(
          partial >= before,
          "resume must preserve partial bytes on every poll",
        );
        return partial >= target;
      });
      await request(`${modelsPath}/pull`, "DELETE");
      assert.equal((await request(modelsPath)).pull.status, "cancelled");
      const remaining = commands();
      assert.ok(!remaining.includes(model.url), "curl must be gone");
      assert.ok(
        !remaining.includes(join(dataDir, "model-pull.lock")),
        "download supervisor must be gone",
      );
      assert.ok(
        !remaining
          .split(/\r?\n/)
          .some(
            (line) =>
              line.includes(packageDir) && line.includes(`pull ${choice}`),
          ),
        "speech pull must be gone",
      );
    }
  }
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
  const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
  const download = await fetch(`${base}/downloads/chatter.zip`);
  assert.equal(download.status, 200);
  assert.ok(
    download.headers
      .get("content-disposition")
      .includes(`chatter-${version}.zip`),
  );
  const downloadedFiles = readChatterArchive(
    Buffer.from(await download.arrayBuffer()),
  );
  for (const [name, content] of downloadedFiles)
    assert.deepEqual(content, readFileSync(join(packageDir, "chatter", name)));
  assert.equal(downloadedFiles.size, 13);
  const chatterJoin = await fetch(`${base}/api/v1/chatter/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Chatter-Origin": extensionOrigin,
    },
    body: JSON.stringify({
      invite: new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
        "invite",
      ),
    }),
  });
  assert.equal(chatterJoin.status, 200);
  assert.equal(chatterJoin.headers.get("set-cookie"), null);
  const chatter = await chatterJoin.json();
  const chatterHeaders = {
    Authorization: `Bearer ${chatter.token}`,
    "X-Chatter-Origin": extensionOrigin,
  };
  assert.equal(
    (
      await fetch(`${base}/api/v1/rooms/${chatter.roomId}/state`, {
        headers: chatterHeaders,
      })
    ).status,
    200,
  );
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, {
      origin: extensionOrigin,
    });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(Error("Chatter WebSocket timeout"));
    }, 5000);
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ws.once("open", () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          clientId: "package-chatter",
          token: chatter.token,
        }),
      ),
    );
    ws.on("message", (data) => {
      if (JSON.parse(data).type === "state.snapshot") {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });
  });
  assert.equal(
    (
      await fetch(`${base}/api/v1/leave`, {
        method: "POST",
        headers: chatterHeaders,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/api/v1/rooms/${chatter.roomId}/state`, {
        headers: chatterHeaders,
      })
    ).status,
    401,
  );
  if (process.argv.includes("--browser")) {
    const { checkPackagedChatter } = await import("./chatter-browser.mjs");
    await checkPackagedChatter({
      packageDir,
      temporary,
      base,
      invite: invite.url,
    });
    await request("/api/v1/admin/commands", "POST", {
      command: "reset-settings",
      commandId: randomUUID(),
      confirm: true,
    });
  }
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
  assert.ok(!(output + failure).includes(chatter.token));
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
  // The admin menu offers the builds this platform's package carries.
  assert.deepEqual(
    runtime.backends,
    process.platform === "win32" ? ["vulkan", "cpu"] : ["metal"],
  );
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
  // Startup settings saved on the admin page apply through a restart inside
  // the process, and the data-directory lock moves with them.
  const startupFile = join(temporary, "起動 設定", "startup.json");
  mkdirSync(dirname(startupFile));
  writeFileSync(
    startupFile,
    JSON.stringify({ dataDir, host: "127.0.0.1", port, publicOrigin: "" }),
  );
  await start([], {
    args: ["--no-browser"],
    env: { ...env, TTS_STARTUP_FILE: startupFile },
  });
  const startup = await request("/api/v1/admin/startup");
  assert.equal(startup.file, startupFile);
  assert.deepEqual(startup.locks, {});
  assert.equal(startup.active.dataDir, dataDir);
  assert.equal((await request("/api/v1/admin/diagnostics")).canRestart, true);
  const restartedDir = join(temporary, "再起動後 data");
  const restartedPort = await unusedPort();
  const { restartId } = await request(
    "/api/v1/admin/startup",
    "PUT",
    { dataDir: restartedDir, port: restartedPort },
    secret,
    202,
  );
  let restarted;
  for (let i = 0; i < 300 && restarted?.state !== "done"; i++) {
    await delay(100);
    try {
      const r = await fetch(`${base}/api/v1/restart-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: restartId }),
      });
      if (r.ok) restarted = await r.json();
    } catch {
      /* Between the two starts. */
    }
  }
  assert.equal(restarted?.state, "done", JSON.stringify(restarted));
  assert.match(
    restarted.adminUrl,
    new RegExp(`^http://127\\.0\\.0\\.1:${restartedPort}/admin/#access=`),
  );
  assert.equal(child.exitCode, null, "the same process keeps running");
  assert.equal(JSON.parse(readFileSync(startupFile)).port, restartedPort);
  assert.ok(existsSync(join(restartedDir, "bridge.sqlite")));
  // The old data directory is free for another Bridge.
  const reusePort = await unusedPort();
  const reuse = spawn(
    exe,
    ["--no-browser", "--data-dir", dataDir, "--port", String(reusePort)],
    { cwd, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let reuseError = "";
  reuse.stderr.on("data", (s) => (reuseError += s));
  for (let i = 0; i < 150; i++) {
    assert.equal(reuse.exitCode, null, `old data directory: ${reuseError}`);
    try {
      if ((await fetch(`http://127.0.0.1:${reusePort}/healthz`)).ok) break;
    } catch {}
    await delay(100);
  }
  const reuseExit = new Promise((resolve) => reuse.once("close", resolve));
  const reuseShutdown = await fetch(
    `http://127.0.0.1:${reusePort}/api/v1/admin/shutdown`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: "{}",
    },
  );
  assert.equal(reuseShutdown.status, 200);
  assert.equal(await reuseExit, 0);
  const startupDataDir = dataDir;
  dataDir = restartedDir;
  base = `http://127.0.0.1:${restartedPort}`;
  assert.ok((await fetch(`${base}/healthz`)).ok);
  await stop();
  dataDir = startupDataDir;
  base = `http://127.0.0.1:${port}`;
  assert.doesNotMatch(output + failure, /#access=|Bearer |trpg_admin=/);
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
    "PASS: isolated SEA, clean initial DB/config, fresh installation secrets, Unicode paths, SQLite restart/reset, assets, Player and Chatter authentication/WebSockets, Collector auth, Discord/Opus, runtime settings/lock/model failure, startup settings restart, missing runtime diagnosis, secret-free redirected logs",
  );
} finally {
  await stop();
  rmSync(temporary, { recursive: true, force: true });
}
