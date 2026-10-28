import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { speechTarget } from "./src/runtime/speech.mjs";

const main = fileURLToPath(new URL("./main.mjs", import.meta.url));
const build = resolve(".packaging/speech-runtime");
const pins = JSON.parse(readFileSync("packaging/speech-lock.json", "utf8"));

// npm start, with its files kept out of the source tree.
function start(dir, args, env = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("TTS_")),
  );
  const child = spawn(process.execPath, [main, ...args], {
    env: { ...clean, TTS_STARTUP_FILE: join(dir, "startup.json"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => (child.output += chunk));
  child.done = new Promise((resolve) => child.once("close", resolve));
  return child;
}
async function ready(child) {
  const deadline = Date.now() + 60000;
  while (!child.output.includes("Bridge ready")) {
    assert.equal(child.exitCode, null, child.output);
    assert.ok(Date.now() < deadline, child.output);
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

test("npm start answers --version and --help without starting Bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "main-options-"));
  try {
    const version = start(dir, ["--version"]);
    assert.equal(await version.done, 0);
    assert.equal(
      version.output.trim(),
      JSON.parse(readFileSync("package.json", "utf8")).version,
    );
    const help = start(dir, ["--help"]);
    assert.equal(await help.done, 0);
    assert.match(help.output, /--data-dir <path> --port <1-65535>\n/);
    assert.match(help.output, /--tts <external\|bundled>/);
    assert.doesNotMatch(help.output, /--self-test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "npm start refuses to start without a speech.cpp build for the pinned source",
  { skip: !speechTarget() },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "main-build-"));
    try {
      const missing = start(dir, ["--no-browser"], {
        TTS_SPEECH_RUNTIME_DIR: join(dir, "none"),
      });
      assert.equal(await missing.done, 1);
      assert.match(missing.output, /speech\.cppのビルドがありません/);
      assert.match(missing.output, /npm run package:speech/);
      const old = join(dir, "old");
      mkdirSync(old);
      writeFileSync(
        join(old, "build.json"),
        JSON.stringify({
          ...pins,
          speech: { ...pins.speech, commit: "0".repeat(40) },
          target: speechTarget(),
        }),
      );
      const mismatch = start(dir, ["--no-browser"], {
        TTS_SPEECH_RUNTIME_DIR: old,
      });
      assert.equal(await mismatch.done, 1);
      assert.match(mismatch.output, /speech-lock\.json と合いません/);
      assert.ok(!existsSync(join(dir, "startup.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "npm start with the speech.cpp build locks its data directory like the package",
  { skip: !speechTarget() || !existsSync(join(build, "build.json")) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "main-lock 保存先-"));
    const data = join(dir, "data");
    const first = start(dir, [
      "--no-browser",
      "--data-dir",
      data,
      "--port",
      String(await freePort()),
    ]);
    try {
      await ready(first);
      const second = start(dir, [
        "--no-browser",
        "--data-dir",
        data,
        "--port",
        String(await freePort()),
      ]);
      assert.equal(await second.done, 1);
      assert.match(second.output, /同じ保存先のBridge/);
    } finally {
      first.kill();
      await first.done;
      // Windows' supervisor lets go of bridge.lock once it reads EOF.
      rmSync(dir, { recursive: true, force: true, maxRetries: 20 });
    }
  },
);

test(
  "npm start runs with an external TTS only where no speech.cpp build exists",
  { skip: Boolean(speechTarget()) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "main-external-"));
    const port = String(await freePort());
    try {
      const refused = start(dir, ["--no-browser", "--tts", "bundled"]);
      assert.equal(await refused.done, 1);
      assert.match(refused.output, /このOSでは内蔵TTSを使えない/);
      const child = start(dir, [
        "--no-browser",
        "--data-dir",
        join(dir, "data"),
        "--port",
        port,
      ]);
      try {
        await ready(child);
        assert.match(child.output, /外部TTSだけで起動します/);
        assert.match(child.output, new RegExp(`127\\.0\\.0\\.1:${port}/`));
      } finally {
        child.kill();
        await child.done;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
