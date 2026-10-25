import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSettings, platformBackends } from "../src/runtime/settings.mjs";
import {
  SpeechRuntime,
  speechLifecycle,
  stopMessage,
} from "../src/runtime/speech.mjs";
import { createApp } from "../src/http.mjs";
import { startBridge } from "../src/runtime/launcher.mjs";
import { StartupSettings } from "../src/runtime/startup.mjs";
import { initialConfig } from "../src/store.mjs";

test("runtime settings preserve saved values under CLI overrides and reject invalid input", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-settings-"));
  try {
    const settings = new RuntimeSettings(dir);
    assert.equal(settings.active.mode, "external");
    settings.save({
      mode: "bundled",
      model: join(dir, "モデル.gguf"),
      ttsPort: 18100,
    });
    const overridden = new RuntimeSettings(dir, {
      mode: "external",
      ttsPort: 18101,
    });
    assert.equal(overridden.active.mode, "external");
    assert.equal(overridden.saved.mode, "bundled");
    assert.equal(new RuntimeSettings(dir).active.ttsPort, 18100);
    for (const invalid of [
      { mode: "bad" },
      { model: "relative.gguf" },
      { ttsPort: 0 },
      { ttsPort: "123" },
    ])
      assert.throws(() => settings.save({ ...settings.saved, ...invalid }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime builds follow the platform and reject another platform's build", () => {
  assert.deepEqual(platformBackends("win32"), ["vulkan", "cpu"]);
  assert.deepEqual(platformBackends("darwin"), ["metal"]);
  const dir = mkdtempSync(join(tmpdir(), "runtime-backend-"));
  const windows = ["vulkan", "cpu"];
  try {
    const settings = new RuntimeSettings(dir, {}, windows);
    assert.equal(settings.saved.backend, "vulkan");
    settings.save({ ...settings.saved, mode: "bundled", backend: "cpu" });
    assert.equal(new RuntimeSettings(dir, {}, windows).active.backend, "cpu");
    const overridden = new RuntimeSettings(dir, { backend: "vulkan" }, windows);
    assert.equal(overridden.active.backend, "vulkan");
    assert.equal(overridden.saved.backend, "cpu");
    assert.throws(
      () => settings.save({ ...settings.saved, backend: "metal" }),
      (e) => e.expose === true,
    );
    // A file saved before the builds were named takes the platform's default.
    writeFileSync(
      join(dir, "runtime.json"),
      JSON.stringify({ mode: "bundled", model: "", ttsPort: 18088 }),
    );
    assert.equal(new RuntimeSettings(dir, {}, windows).saved.backend, "vulkan");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Vulkan build runs on the GPU and a missing loader is named", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-command-"));
  const runtimeDir = join(dir, "runtime");
  const start = (backend) =>
    new SpeechRuntime({
      dataDir: dir,
      runtimeDir,
      overrides: { mode: "bundled", model: join(dir, "model.gguf"), backend },
      backends: ["vulkan", "cpu"],
    }).speechCommand();
  try {
    const vulkan = start("vulkan");
    assert.match(vulkan[2], /[\\/]speech-vulkan(\.exe)?$/);
    const device = vulkan.indexOf("--device");
    assert.deepEqual(vulkan.slice(device, device + 2), ["--device", "gpu"]);
    const cpu = start("cpu");
    assert.match(cpu[2], /[\\/]speech(\.exe)?$/);
    assert.ok(!cpu.includes("--device"));
    assert.ok(!cpu.includes("--irodori-compatible"));
    assert.ok(!cpu.includes("--voices-dir"));
    assert.match(stopMessage(0xc0000135, "vulkan"), /Vulkanが見つかりません/);
    assert.match(stopMessage(1, "vulkan"), /停止.*CPU/);
    assert.doesNotMatch(stopMessage(0xc0000135, "cpu"), /Vulkan/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effective bundled provider never overwrites the external provider and gates requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-provider-"));
  const runtime = new SpeechRuntime({
    dataDir: dir,
    runtimeDir: dir,
    overrides: { mode: "bundled" },
  });
  const initial = initialConfig({});
  initial.provider = {
    ...initial.provider,
    type: "mock",
    baseUrl: "http://external.invalid:8088",
  };
  const app = createApp({
    dataDir: dir,
    initial,
    runtime,
    providerOptions: {
      resolveProvider: (saved) => runtime.provider(saved),
      fetchImpl: runtime.fetch,
    },
  });
  try {
    assert.equal(app.engine.config.provider.type, "speech");
    assert.equal(app.engine.config.provider.baseUrl, "http://127.0.0.1:18088");
    assert.deepEqual(app.store.config.provider, initial.provider);
    assert.throws(
      () => runtime.fetch("http://127.0.0.1:18088/health"),
      /準備中/,
    );
    await runtime.start();
    assert.equal(runtime.status, "error");
    assert.match(runtime.error, /GGUF/);
    assert.deepEqual(app.store.config.provider, initial.provider);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const helper = resolve(
  ".packaging/native-build",
  ...(process.platform === "win32"
    ? ["Release", "bridge-supervisor.exe"]
    : ["bridge-supervisor"]),
);
function supervise(args) {
  const child = spawn(helper, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  child.events = [];
  createInterface({ input: child.stdout }).on("line", (line) =>
    child.events.push(JSON.parse(line)),
  );
  child.stderr.resume();
  child.done = new Promise((resolve) => child.once("close", resolve));
  return child;
}
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    const result = await fn();
    if (result) return result;
    await delay(50);
  }
  throw Error("Timed out");
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "native supervisor locks data, terminates owned child on EOF, and permits restart",
  { skip: !existsSync(helper) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "監視 space-"));
    let first, second, third;
    try {
      const script = join(dir, "fake speech.cjs");
      writeFileSync(script, "setInterval(() => {}, 1000);\n");
      const lock = join(dir, "bridge.lock");
      first = supervise([lock, process.execPath, script]);
      await until(() => first.events.find((e) => e.event === "locked"));
      second = supervise([lock]);
      assert.equal(await second.done, 3);
      first.stdin.write("S");
      const { pid } = await until(() =>
        first.events.find((e) => e.event === "spawned"),
      );
      assert.ok(alive(pid));
      first.stdin.end(); // Same kernel EOF as abrupt Bridge exit.
      assert.equal(await first.done, 0);
      await until(() => !alive(pid));
      third = supervise([lock]);
      await until(() => third.events.find((e) => e.event === "locked"));
      third.stdin.end("Q");
      assert.equal(await third.done, 0);
    } finally {
      for (const child of [first, second, third])
        if (child) {
          child.stdin.end();
          await child.done;
        }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "native supervisor stops a startup timeout without releasing the data lock",
  { skip: !existsSync(helper) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-timeout-"));
    let owner, competitor;
    try {
      const script = join(dir, "child.cjs");
      writeFileSync(script, "setInterval(() => {}, 1000);");
      const lock = join(dir, "bridge.lock");
      owner = supervise([lock, process.execPath, script]);
      await until(() => owner.events.some((e) => e.event === "locked"));
      owner.stdin.write("S");
      const { pid } = await until(() =>
        owner.events.find((e) => e.event === "spawned"),
      );
      owner.stdin.write("T");
      await until(() => !alive(pid));
      competitor = supervise([lock]);
      assert.equal(await competitor.done, 3);
      owner.stdin.end("Q");
      assert.equal(await owner.done, 0);
    } finally {
      for (const child of [owner, competitor])
        if (child) {
          child.stdin.end();
          await child.done;
        }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

const runtimeDir = resolve(".packaging/speech-runtime");
test(
  "readiness identifies the owned listener without any console output",
  { skip: !existsSync(helper) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-listener-"));
    const probe = createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    let child;
    try {
      const script = join(dir, "silent.cjs");
      writeFileSync(
        script,
        `require('node:net').createServer(socket => socket.end()).listen(${port}, '127.0.0.1');`,
      );
      child = supervise([
        join(dir, "bridge.lock"),
        "--listen-port",
        String(port),
        process.execPath,
        script,
      ]);
      await until(() => child.events.some((e) => e.event === "locked"));
      child.stdin.write("S");
      await until(() => child.events.some((e) => e.event === "listening"));
    } finally {
      if (child) {
        child.stdin.end("Q");
        await child.done;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a foreign listener and misleading console text never satisfy ownership",
  { skip: !existsSync(helper) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-foreign-"));
    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    let child;
    try {
      const script = join(dir, "misleading.cjs");
      writeFileSync(
        script,
        `console.error('speech serve: speech.cpp changed, listening on http://127.0.0.1:${port}'); setInterval(() => {}, 1000);`,
      );
      child = supervise([
        join(dir, "bridge.lock"),
        "--listen-port",
        String(port),
        process.execPath,
        script,
      ]);
      await until(() => child.events.some((e) => e.event === "locked"));
      child.stdin.write("S");
      await until(() => child.events.some((e) => e.event === "spawned"));
      await delay(250);
      assert.ok(!child.events.some((e) => e.event === "listening"));
    } finally {
      if (child) {
        child.stdin.end("Q");
        await child.done;
      }
      assert.ok(server.listening);
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "port conflicts leave the unrelated server alive and never become ready",
  { skip: !existsSync(join(runtimeDir, "build.json")) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-conflict-"));
    const server = createServer((socket) => socket.end());
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const model = join(dir, "test.gguf");
    writeFileSync(model, "invalid model");
    const runtime = new SpeechRuntime({
      dataDir: dir,
      runtimeDir,
      overrides: { mode: "bundled", model, ttsPort: server.address().port },
    });
    try {
      await runtime.acquire();
      await runtime.start();
      assert.equal(runtime.status, "error");
      assert.match(runtime.error, /ポート/);
      assert.equal(runtime.childAlive, undefined);
      await runtime.close();
      assert.ok(server.listening);
    } finally {
      await runtime.close();
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "invalid model child exit is reported while the data lock remains held",
  { skip: !existsSync(join(runtimeDir, "build.json")) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-bad-model-"));
    const model = join(dir, "test.gguf");
    writeFileSync(model, "invalid model");
    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    const runtime = new SpeechRuntime({
      dataDir: dir,
      runtimeDir,
      overrides: { mode: "bundled", model, ttsPort: port },
      startupTimeout: 10000,
    });
    try {
      await runtime.acquire();
      await runtime.start();
      assert.equal(runtime.status, "error");
      assert.match(runtime.error, /停止/);
      assert.throws(() => runtime.fetch(`http://127.0.0.1:${port}/health`));
      const competitor = supervise([join(dir, "bridge.lock")]);
      assert.equal(await competitor.done, 3);
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a second runtime on the same data directory gets a user-facing lock message",
  { skip: !existsSync(join(runtimeDir, "build.json")) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-lock 保存先-"));
    const first = new SpeechRuntime({ dataDir: dir, runtimeDir });
    const second = new SpeechRuntime({ dataDir: dir, runtimeDir });
    try {
      await first.acquire();
      await assert.rejects(
        second.acquire(),
        (e) =>
          e.expose === true &&
          e.message.includes("同じ保存先のBridge") &&
          e.message.includes(dir),
      );
    } finally {
      await second.close();
      await first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a restart moves the data-directory lock and refuses a directory another Bridge owns",
  {
    skip: !existsSync(
      join(
        runtimeDir,
        process.platform === "win32"
          ? "bridge-supervisor.exe"
          : "bridge-supervisor",
      ),
    ),
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-restart-"));
    const probe = createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const speech = speechLifecycle({ runtimeDir });
    const handle = await startBridge({
      startup: new StartupSettings({
        file: join(dir, "startup.json"),
        defaults: {
          dataDir: join(dir, "a"),
          host: "127.0.0.1",
          port,
          publicOrigin: "",
        },
      }),
      prepare: speech.prepare,
      boot: (active, prepared) =>
        speech.boot(active, prepared, () => {
          const initial = initialConfig({});
          initial.provider.type = "mock";
          return {
            initial,
            localOrigin: `http://127.0.0.1:${active.port}`,
          };
        }),
    });
    const admin = async (path, method, body) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/admin/${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${handle.app.store.secrets.admin}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      return { status: response.status, data: await response.json() };
    };
    let other;
    try {
      const first = speech.runtime;
      other = new SpeechRuntime({ dataDir: join(dir, "b"), runtimeDir });
      await other.acquire();
      const refused = await admin("startup", "PUT", {
        dataDir: join(dir, "b"),
      });
      assert.equal(refused.status, 409);
      assert.match(refused.data.error, /同じ保存先のBridge/);
      assert.equal(speech.runtime, first);
      await other.close();
      other = undefined;
      // A model download in progress also keeps Bridge as it is.
      first.models.job = { status: "running" };
      const downloading = await admin("restart", "POST", {});
      assert.equal(downloading.status, 409);
      assert.match(downloading.data.error, /ダウンロード中/);
      first.models.job = null;
      const { status, data } = await admin("startup", "PUT", {
        dataDir: join(dir, "b"),
      });
      assert.equal(status, 202);
      const done = await until(async () => {
        try {
          const r = await fetch(
            `http://127.0.0.1:${port}/api/v1/restart-status`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: data.restartId }),
            },
          );
          const result = r.ok ? await r.json() : null;
          return result?.state === "restarting" ? null : result;
        } catch {
          return null;
        }
      });
      assert.equal(done.state, "done");
      assert.notEqual(speech.runtime, first);
      assert.equal(speech.runtime.dataDir, join(dir, "b"));
      const reuse = new SpeechRuntime({ dataDir: join(dir, "a"), runtimeDir });
      await reuse.acquire();
      await reuse.close();
      const blocked = new SpeechRuntime({
        dataDir: join(dir, "b"),
        runtimeDir,
      });
      await assert.rejects(blocked.acquire(), /同じ保存先のBridge/);
    } finally {
      await other?.close();
      await handle.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "failed speech boot releases both newly acquired and prepared data-directory locks",
  {
    skip: !existsSync(
      join(
        runtimeDir,
        process.platform === "win32"
          ? "bridge-supervisor.exe"
          : "bridge-supervisor",
      ),
    ),
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-boot-failure-"));
    const speech = speechLifecycle({ runtimeDir });
    try {
      for (const preflight of [false, true]) {
        const active = {
          dataDir: join(dir, preflight ? "prepared" : "direct"),
        };
        const prepared = preflight
          ? await speech.prepare(active, { dataDir: join(dir, "previous") })
          : undefined;
        const failure = new Error("options construction failed");
        await assert.rejects(
          speech.boot(active, prepared, async () => {
            throw failure;
          }),
          (error) => error === failure,
        );
        assert.equal(speech.runtime.status, "stopped");
        // Verify the real supervisor's lock, not just the close method call.
        const replacement = new SpeechRuntime({
          dataDir: active.dataDir,
          runtimeDir,
        });
        try {
          await replacement.acquire();
        } finally {
          await replacement.close();
        }
      }
    } finally {
      await speech.runtime?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
