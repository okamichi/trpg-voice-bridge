// Opt-in local-model validation. Never downloads or copies a model.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  cpSync,
  rmSync,
  readFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ReferenceVoices } from "../src/reference-voices.mjs";

const model = process.env.BRIDGE_TEST_MODEL;
if (!model)
  throw Error(
    "Set BRIDGE_TEST_MODEL to an existing local GGUF; this test does not download models",
  );
const dir = mkdtempSync(join(tmpdir(), "bridge-tts-"));
let packageDir = join(dir, "配布 package"),
  child,
  token,
  output = "";
cpSync(
  resolve(process.argv[2] ?? `dist/${process.platform}-${process.arch}`),
  packageDir,
  { recursive: true },
);
const dataDir = join(dir, "保存 data");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(TTS_|NODE_|NAPI_RS_|DISCORD_)/.test(key),
  ),
);
env.PATH = "";
async function freePort() {
  const server = createServer();
  await new Promise((r, j) => {
    server.once("error", j);
    server.listen(0, "127.0.0.1", r);
  });
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
const port = await freePort(),
  ttsPort = await freePort(),
  base = `http://127.0.0.1:${port}`;
async function until(fn, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw Error("Timed out");
}
async function api(path, body) {
  const response = await fetch(`${base}/api/v1/admin/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200, path);
  return response;
}
async function start() {
  child = spawn(
    join(
      packageDir,
      `trpg-voice-bridge${process.platform === "win32" ? ".exe" : ""}`,
    ),
    [
      "--no-browser",
      "--data-dir",
      dataDir,
      "--port",
      String(port),
      "--tts",
      "bundled",
      "--tts-port",
      String(ttsPort),
      "--model",
      model,
    ],
    { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  child.done = new Promise((r) => child.once("close", r));
  await until(async () => {
    assert.equal(child.exitCode, null);
    try {
      return (await fetch(`${base}/healthz`)).ok;
    } catch {
      return false;
    }
  });
  const db = new DatabaseSync(join(dataDir, "bridge.sqlite"), {
    readOnly: true,
  });
  token = JSON.parse(
    db.prepare("SELECT data FROM auth WHERE key='secrets'").get().data,
  ).admin;
  db.close();
}
async function ready() {
  await until(async () => {
    const runtime = await (await api("runtime")).json();
    assert.notEqual(runtime.status, "error", runtime.error);
    return runtime.status === "ready";
  });
}
async function stop(force = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (force) child.kill("SIGKILL");
  else await api("shutdown", {});
  await child.done;
  // The detached guardian needs a moment to collect its child after EOF.
  await until(async () => {
    try {
      await fetch(`http://127.0.0.1:${ttsPort}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      return false;
    } catch {
      return true;
    }
  }, 15000);
  if (!force) assert.equal(child.exitCode, 0);
  child = undefined;
}
const voice = {
  id: "smoke",
  name: "smoke",
  provider: "irodori-local",
  voiceId: "none",
  caption: "落ち着いた声",
  seed: "42",
  speed: 1,
  steps: 4,
};
async function preview(voiceId) {
  const response = await api("previews", {
    requestId: randomUUID(),
    text: "こんにちは。",
    voice: { ...voice, voiceId },
  });
  const wav = Buffer.from(await response.arrayBuffer());
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.ok(wav.length > 44);
  return wav;
}
try {
  await start();
  await ready();
  const wav = await preview("none");
  const references = new ReferenceVoices(fetch);
  const provider = { type: "irodori", baseUrl: `http://127.0.0.1:${ttsPort}` };
  await references.register({ provider, voiceId: "package-smoke", wav });
  await references.close();
  assert.ok(existsSync(join(dataDir, "voices/package-smoke.wav")));
  await stop();
  const moved = join(dir, "展開先を変更 moved");
  renameSync(packageDir, moved);
  packageDir = moved;
  await start();
  await ready();
  const voices = await (await api("providers/irodori-local/voices")).json();
  assert.ok(voices.some((v) => v.id === "package-smoke"));
  await preview("package-smoke");
  await stop(true); // Abrupt Bridge death must also collect speech.cpp.
  await start();
  await ready();
  await stop();
  assert.doesNotMatch(output, /#access=|Bearer |trpg_admin=/);
  assert.ok(!output.includes(token));
  assert.doesNotMatch(
    readFileSync(join(dataDir, "logs/speech.log"), "utf8"),
    /http|#access|token|Bearer/,
  );
  console.log(
    "PASS: local-model generation, persistent voices after relocation/restart, normal and abrupt child cleanup, secret-free logs",
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null)
    await stop(true);
  rmSync(dir, { recursive: true, force: true });
}
