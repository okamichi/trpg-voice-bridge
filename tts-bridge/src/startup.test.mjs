import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  StartupSettings,
  launchOverrides,
  probePort,
  checkDataDir,
} from "./runtime/startup.mjs";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-startup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const defaults = {
    dataDir: join(dir, "data"),
    host: "127.0.0.1",
    port: 8090,
    publicOrigin: "",
  };
  return { dir, file: join(dir, "startup.json"), defaults };
}

test("defaults apply without a file, and the data directory falls back to the default", (t) => {
  const { file, defaults } = setup(t);
  const settings = new StartupSettings({ file, defaults });
  assert.equal(settings.saved, null);
  assert.deepEqual(settings.active, defaults);
  assert.deepEqual(settings.snapshot().locks, {});
});

test("saved values win over defaults, environment over saved, options over environment", (t) => {
  const { dir, file, defaults } = setup(t);
  writeFileSync(
    file,
    JSON.stringify({
      dataDir: join(dir, "saved"),
      host: "0.0.0.0",
      port: 9000,
      publicOrigin: "http://203.0.113.10:9000",
    }),
  );
  assert.deepEqual(new StartupSettings({ file, defaults }).active, {
    dataDir: join(dir, "saved"),
    host: "0.0.0.0",
    port: 9000,
    publicOrigin: "http://203.0.113.10:9000",
  });
  const env = {
    TTS_DATA_DIR: "env-data",
    TTS_BRIDGE_HOST: "127.0.0.1",
    TTS_BRIDGE_PORT: "9100",
    TTS_PUBLIC_ORIGIN: "https://voice.example.com",
  };
  const fromEnv = new StartupSettings({
    file,
    defaults,
    ...launchOverrides(env),
  });
  assert.deepEqual(fromEnv.active, {
    dataDir: resolve("env-data"),
    host: "127.0.0.1",
    port: 9100,
    publicOrigin: "https://voice.example.com",
  });
  assert.deepEqual(fromEnv.locks, {
    dataDir: "TTS_DATA_DIR",
    host: "TTS_BRIDGE_HOST",
    port: "TTS_BRIDGE_PORT",
    publicOrigin: "TTS_PUBLIC_ORIGIN",
  });
  const fromOptions = new StartupSettings({
    file,
    defaults,
    ...launchOverrides(env, { dataDir: "option-data", port: "9200" }),
  });
  assert.equal(fromOptions.active.dataDir, resolve("option-data"));
  assert.equal(fromOptions.active.port, 9200);
  assert.equal(fromOptions.locks.dataDir, "--data-dir");
  assert.equal(fromOptions.locks.port, "--port");
  // Overrides never rewrite the saved value.
  assert.equal(fromOptions.saved.port, 9000);
});

test("TTS_LOCAL_ORIGIN pins the port it was started with", (t) => {
  const { file, defaults } = setup(t);
  writeFileSync(file, JSON.stringify({ port: 9000 }));
  const settings = new StartupSettings({
    file,
    defaults,
    ...launchOverrides({ TTS_LOCAL_ORIGIN: "http://127.0.0.1:9000" }),
  });
  assert.equal(settings.locks.port, "TTS_LOCAL_ORIGIN");
  assert.equal(settings.plan("reset").active.port, 9000);
  assert.throws(
    () => settings.plan("save", { port: 9001 }),
    /環境変数 TTS_LOCAL_ORIGINで指定中/,
  );
});

test("plans validate input, refuse locked fields, and apply only when asked", (t) => {
  const { dir, file, defaults } = setup(t);
  const settings = new StartupSettings({
    file,
    defaults,
    ...launchOverrides({ TTS_PUBLIC_ORIGIN: "" }),
  });
  for (const [input, message] of [
    [{ dataDir: "relative/data" }, /絶対パス/],
    [{ host: "192.0.2.1" }, /127\.0\.0\.1か0\.0\.0\.0/],
    [{ port: 0 }, /1～65535/],
    [{ port: "8091" }, /1～65535/],
    [{ unknown: 1 }, /起動設定が不正です/],
    [{ publicOrigin: "https://example.com" }, /環境変数 TTS_PUBLIC_ORIGIN/],
  ])
    assert.throws(() => settings.plan("save", input), message);
  const plan = settings.plan("save", {
    dataDir: join(dir, "other"),
    port: 8091,
  });
  assert.equal(plan.active.port, 8091);
  assert.equal(existsSync(file), false, "planning alone saves nothing");
  settings.apply(plan);
  assert.equal(settings.active.port, 8091);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    dataDir: join(dir, "other"),
    host: "127.0.0.1",
    port: 8091,
    publicOrigin: "",
  });
  if (process.platform !== "win32")
    assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(`${file}.tmp`), false);
  const reset = settings.plan("reset");
  assert.deepEqual(reset.active, defaults);
  settings.apply(reset);
  assert.equal(existsSync(file), false);
  assert.equal(settings.saved, null);
});

test("public origins must be a bare http or https origin", (t) => {
  const { file, defaults } = setup(t);
  const settings = new StartupSettings({ file, defaults });
  for (const value of [
    "http://example.com/",
    "http://example.com/path",
    "ftp://example.com",
    "example.com",
  ])
    assert.throws(
      () => settings.plan("save", { publicOrigin: value }),
      /公開Origin/,
    );
  assert.equal(
    settings.plan("save", { publicOrigin: "https://voice.example.com:8443" })
      .active.publicOrigin,
    "https://voice.example.com:8443",
  );
  assert.throws(
    () =>
      new StartupSettings({
        file,
        defaults,
        ...launchOverrides({ TTS_PUBLIC_ORIGIN: "https://example.com/" }),
      }),
    /公開Origin/,
  );
  assert.throws(
    () =>
      new StartupSettings({
        file,
        defaults,
        ...launchOverrides({ TTS_BRIDGE_PORT: "70000" }),
      }),
    /1～65535/,
  );
});

test("an unreadable settings file stops the start and names the file", (t) => {
  const { file, defaults } = setup(t);
  for (const content of ["{", "[]", JSON.stringify({ port: -1 })]) {
    writeFileSync(file, content);
    assert.throws(
      () => new StartupSettings({ file, defaults }),
      (e) =>
        e.expose === true &&
        e.message.includes(file) &&
        e.message.includes("削除すると既定値で起動します"),
    );
  }
});

test("preflight reports a busy port and an unwritable data directory", async (t) => {
  const { dir } = setup(t);
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { port } = server.address();
  await assert.rejects(probePort(port, "127.0.0.1"), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, new RegExp(`ポート${port}は使用中`));
    return true;
  });
  const file = join(dir, "file");
  writeFileSync(file, "");
  assert.throws(
    () => checkDataDir(join(file, "data")),
    (e) => e.status === 409 && /保存先を作成できない/.test(e.message),
  );
  checkDataDir(join(dir, "new", "data"));
  assert.equal(statSync(join(dir, "new", "data")).isDirectory(), true);
});
