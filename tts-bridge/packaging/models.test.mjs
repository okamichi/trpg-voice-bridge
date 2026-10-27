import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { SpeechModels } from "../src/runtime/models.mjs";
import { createApp } from "../src/http.mjs";
const supervisor = resolve(
  ".packaging/native-build",
  ...(process.platform === "win32"
    ? ["Release", "bridge-supervisor.exe"]
    : ["bridge-supervisor"]),
);
const fixture = resolve("packaging/fixtures/model-speech.cjs");
async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "models-test-"));
  const options = {
    dataDir: dir,
    speech: [process.execPath, fixture, dir],
    supervisor,
  };
  const models = new SpeechModels(options);
  t.after(async () => {
    await models.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { models, dir, options };
}
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await delay(50);
  }
  throw Error("timeout");
}
const choice = "irodori-tts:q4_k";
test("catalog filters, defaults, persistence, validation and directory-scoped in-flight requests", async (t) => {
  const { models, dir, options } = await setup(t);
  const first = await models.list();
  assert.equal(first.models.length, 8);
  assert.equal(first.dir, first.defaultDir);
  await assert.rejects(models.setDir("relative"), { status: 400 });
  writeFileSync(join(dir, "mode"), "slow");
  const old = models.list();
  const next = join(dir, "日本語 new");
  await models.setDir(next);
  assert.equal((await models.list()).dir, next);
  assert.equal((await old).dir, next);
  const restored = new SpeechModels(options);
  assert.equal((await restored.list()).dir, next);
  await restored.close();
  await models.setDir(first.defaultDir);
  assert.equal(JSON.parse(readFileSync(join(dir, "models.json"))).dir, "");
});
test("reservation prevents concurrent pulls and directory mutation; starting cancellation never spawns", async (t) => {
  const { models, dir } = await setup(t);
  await models.list();
  writeFileSync(join(dir, "mode"), "slow");
  const first = models.pull(choice);
  await assert.rejects(models.pull(choice), { status: 409 });
  await assert.rejects(models.setDir(join(dir, "other")), { status: 409 });
  await models.cancel();
  await first;
  assert.equal(models.job.status, "cancelled");
  assert.equal(models.helper, undefined);
  await assert.rejects(models.pull("qwen3-tts:q4_k"), { status: 400 });
});
test(
  "real supervisor: progress, verified completion, missing output and upstream errors",
  { skip: !existsSync(supervisor) },
  async (t) => {
    const { models, dir } = await setup(t);
    await models.pull(choice);
    await until(
      async () =>
        (await models.list()).models.find((m) => m.choice === choice).partial >
        0,
    );
    await models.finished;
    assert.equal(models.job.status, "done");
    assert.ok(existsSync(models.job.path));
    writeFileSync(join(dir, "mode"), "missing");
    await models.pull("irodori-tts:q8_0");
    await models.finished;
    assert.equal(models.job.status, "error");
    assert.match(models.job.error, /見つかりません/);
    writeFileSync(join(dir, "mode"), "error");
    await models.pull(choice);
    await models.finished;
    assert.equal(models.job.error, "speech: io: test failure");
  },
);
for (const operation of ["cancel", "close", "eof"])
  test(
    `real supervisor cleans speech and grandchild on ${operation}`,
    { skip: !existsSync(supervisor) },
    async (t) => {
      const { models, dir } = await setup(t);
      writeFileSync(join(dir, "mode"), "tree");
      await models.pull(choice);
      await until(() => existsSync(join(dir, "pids")));
      const pids = JSON.parse(readFileSync(join(dir, "pids")));
      if (operation === "eof") {
        models.helper.stdin.end();
        await models.finished;
      } else await models[operation]();
      await until(() =>
        pids.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        }),
      );
      if (operation !== "eof") assert.equal(models.job.status, "cancelled");
    },
  );
test("admin routes authenticate, validate and reserve concurrent requests; credits default and payload", async (t) => {
  const { models, dir } = await setup(t);
  writeFileSync(join(dir, "mode"), "slow");
  const credits = {
    entries: [{ title: "test", license: "license" }],
    footer: "",
  };
  // SQLite stays open until app.close(); Windows cannot delete it before then,
  // and setup's cleanup hook runs first.
  const appDir = mkdtempSync(join(tmpdir(), "models-app-"));
  const app = createApp({
    dataDir: appDir,
    runtime: { models },
    credits,
    localOrigin: "http://127.0.0.1:0",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await app.close();
    rmSync(appDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const token = app.store.secrets.admin;
  const request = (path, method = "GET", body, auth = true) =>
    fetch(`${base}/api/v1/admin/${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  for (const [p, m] of [
    ["models", "GET"],
    ["models/dir", "PUT"],
    ["models/pull", "POST"],
    ["models/pull", "DELETE"],
    ["credits", "GET"],
  ])
    assert.equal((await request(p, m, undefined, false)).status, 401);
  assert.deepEqual(await (await request("credits")).json(), credits);
  assert.equal((await request("models")).status, 200);
  assert.equal(
    (await request("models/dir", "PUT", { dir: "relative" })).status,
    400,
  );
  // Cancel while validation runs: avoids requiring a native helper in this API test.
  const a = request("models/pull", "POST", { choice });
  await delay(30);
  const b = await request("models/pull", "POST", { choice });
  assert.equal(b.status, 409);
  const cancel = request("models/pull", "DELETE");
  assert.equal((await a).status, 202);
  assert.equal((await cancel).status, 200);
});

test(
  "macOS fallback kills the process group when supervisor is frozen",
  {
    skip: process.platform !== "darwin" || !existsSync(supervisor),
    timeout: 20000,
  },
  async (t) => {
    const { models, dir } = await setup(t);
    writeFileSync(join(dir, "mode"), "tree");
    await models.pull(choice);
    await until(() => existsSync(join(dir, "pids")));
    const pids = JSON.parse(readFileSync(join(dir, "pids")));
    const helperPid = models.helper.pid;
    process.kill(helperPid, "SIGSTOP");
    await models.cancel();
    assert.equal(models.job.status, "error");
    assert.match(models.job.error, /止められません/);
    await until(() =>
      [...pids, helperPid].every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }),
    );
  },
);

test("credits use the supplied repository for the link and label", async () => {
  const { credits } = await import("../src/runtime/credits.mjs");
  const entry = credits("MIT", "MIT", {
    repository: "another/speech.cpp",
    commit: "abcdef012345",
  }).entries[1];
  assert.equal(entry.linkText, "another/speech.cpp（abcdef0）");
  assert.equal(
    entry.url,
    "https://github.com/another/speech.cpp/tree/abcdef012345",
  );
});

test("recognition catalog exposes four Japanese models and shares the download reservation", async (t) => {
  const { models, dir } = await setup(t);
  writeFileSync(join(dir, "mode"), "recognition");
  const listed = await models.list();
  const recognition = listed.models.filter((m) => m.task === "recognition");
  assert.equal(recognition.length, 16);
  assert.equal(listed.models.filter((m) => m.task === "synthesis").length, 8);
  assert.ok(
    !listed.models.some(
      (m) =>
        m.choice.endsWith(":f16") ||
        m.choice.startsWith("parakeet-tdt-0.6b-v3:"),
    ),
  );
  await models.pull("qwen3-asr-0.6b:q8_0");
  await assert.rejects(models.pull(choice), { status: 409 });
  await models.finished;
  assert.equal(models.job.status, "done");
  assert.ok(
    (await models.list()).models.find((m) => m.choice === "qwen3-asr-0.6b:q8_0")
      .fetched,
  );
});
