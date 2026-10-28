import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "./extension.mjs";
import { fakeEngine, until, tick } from "./test-helpers.mjs";
import { mockWav } from "../src/provider.mjs";
const A = "11111111111111111",
  B = "22222222222222222";
function setup(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "discord-ext-")),
    engine = fakeEngine();
  const calls = [],
    previews = [],
    logs = [],
    bots = [];
  engine.preview = async (...args) => {
    previews.push(args);
    return mockWav();
  };
  const botFactory = async (options) => {
    calls.push(["login", options.token]);
    let state = "logged-in";
    const bot = {
      options,
      connect: async (...ids) => {
        calls.push(["connect", ...ids]);
        state = "connected";
      },
      disconnect: async () => {
        calls.push(["disconnect"]);
        state = "logged-in";
      },
      close: async () => {
        calls.push(["close"]);
        state = "logged-out";
      },
      channels: async () => [
        { guildId: A, channelId: A, canSpeak: true },
        { guildId: B, channelId: B, canSpeak: true },
        { guildId: A, channelId: B, canSpeak: false },
      ],
      textChannels: async () => [
        { guildId: A, channelId: B, canSend: true },
        { guildId: B, channelId: A, canSend: false },
      ],
      cancelDesigns: () => calls.push(["cancel-designs"]),
      status: () => ({
        state,
        botName: "Bot",
        inviteUrl: "https://discord.com/test",
      }),
    };
    bots.push(bot);
    return bot;
  };
  const extensions = [];
  const create = (options = {}) => {
    const ext = createExtension({
      engine,
      dataDir: dir,
      botFactory,
      installed: true,
      log: (s) => logs.push(s),
      ...extra,
      ...options,
    });
    extensions.push(ext);
    return ext;
  };
  const ext = create();
  t.after(async () => {
    for (const e of extensions) await e.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (path, method = "GET", body, extension = ext) =>
    extension.admin({ path, method, body });
  const saved = () => JSON.parse(readFileSync(join(dir, "discord.json")));
  return {
    dir,
    engine,
    ext,
    create,
    request,
    saved,
    calls,
    previews,
    logs,
    bots,
  };
}
test("voice design is opt-in, validates text permissions and persists independently of voice connection", async (t) => {
  const f = setup(t);
  assert.equal((await f.request("status")).data.design.enabled, false);
  await f.request("settings", "PUT", { enabled: true, token: "private-token" });
  await assert.rejects(
    f.request("design", "PUT", { enabled: true, guildId: B, channelId: A }),
    /テキストチャンネル/,
  );
  const result = await f.request("design", "PUT", {
    enabled: true,
    guildId: A,
    channelId: B,
  });
  assert.deepEqual(result.data.design, {
    enabled: true,
    guildId: A,
    channelId: B,
  });
  assert.deepEqual(f.bots[0].options.designSettings(), result.data.design);
  assert.equal(
    f.calls.some((c) => c[0] === "connect"),
    false,
  );
  assert.equal(f.saved().design.channelId, B);
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
  await f.request("design", "PUT", { enabled: false });
  assert.equal(f.saved().design.enabled, false);
  assert.equal(f.calls.filter((c) => c[0] === "cancel-designs").length, 2);
});
test("settings persist privately, token never returned, toggle and reconnect honor saved intent", async (t) => {
  const f = setup(t);
  let result = await f.request("settings", "PUT", {
    enabled: true,
    token: "private-token",
  });
  assert.equal(result.data.tokenSet, true);
  assert.doesNotMatch(JSON.stringify(result), /private-token/);
  // Windows stat.mode does not expose NTFS ACLs as POSIX permission bits.
  if (process.platform !== "win32")
    assert.equal(statSync(join(f.dir, "discord.json")).mode & 0o777, 0o600);
  await f.request("settings", "PUT", { channel: { guildId: A, channelId: A } });
  await f.request("connect", "POST", {});
  await f.request("settings", "PUT", { enabled: false });
  await f.request("settings", "PUT", { enabled: true });
  assert.deepEqual(f.calls.slice(-2), [
    ["login", "private-token"],
    ["connect", A, A],
  ]);
  await f.request("settings", "PUT", { channel: { guildId: B, channelId: B } });
  assert.deepEqual(f.calls.at(-1), ["connect", B, B]);
  await f.ext.close();
  const beforeRestart = f.calls.length;
  const restart = f.create();
  await restart.ready;
  assert.deepEqual(f.calls.slice(beforeRestart), [["login", "private-token"]]);
  assert.equal(
    (await f.request("status", "GET", undefined, restart)).data.autoConnect,
    false,
  );
  await f.request(
    "settings",
    "PUT",
    { channel: { guildId: A, channelId: A } },
    restart,
  );
  assert.deepEqual(f.calls.slice(beforeRestart), [["login", "private-token"]]);
  await f.request(
    "settings",
    "PUT",
    { channel: { guildId: B, channelId: B } },
    restart,
  );
  await f.request("connect", "POST", {}, restart);
  assert.deepEqual(f.calls.at(-1), ["connect", B, B]);
  await f.request("disconnect", "POST", {}, restart);
  await restart.close();
  const before = f.calls.length,
    restart2 = f.create();
  await restart2.ready;
  assert.deepEqual(f.calls.slice(before), [["login", "private-token"]]);
  await f.request("token", "DELETE", undefined, restart2);
  assert.equal("token" in f.saved(), false);
  assert.equal(f.saved().channelId, B);
  assert.equal(
    (await f.request("status", "GET", undefined, restart2)).data.tokenSet,
    false,
  );
});
test("input validation rejects invalid token, channel pair, permissions, text and voice", async (t) => {
  const f = setup(t);
  await f.request("settings", "PUT", { enabled: true, token: "secret" });
  for (const body of [
    { enabled: "yes" },
    { token: "" },
    { token: "a b" },
    { token: "a".repeat(201) },
    { channel: { guildId: "1", channelId: "2" } },
    { channel: { guildId: B, channelId: A } },
    { channel: { guildId: A, channelId: B } },
  ]) {
    await assert.rejects(f.request("settings", "PUT", body), { status: 422 });
  }
  for (const body of [
    { enterText: "a".repeat(101), leaveText: "", voiceProfileId: "voice" },
    { enterText: "<x>", leaveText: "", voiceProfileId: "voice" },
    { enterText: "x", leaveText: "", voiceProfileId: "missing" },
  ]) {
    await assert.rejects(f.request("greeting", "PUT", body), { status: 422 });
  }
  assert.equal(f.saved().token, "secret");
});
test("greeting caches survive restart, refresh on voice/provider changes; leave never generates", async (t) => {
  const f = setup(t);
  const greeting = {
    enterText: "こんにちは",
    leaveText: "さようなら",
    voiceProfileId: "voice",
  };
  await f.request("greeting", "PUT", greeting);
  await until(() => Object.keys(f.saved().hashes).length === 2);
  assert.equal(f.previews.length, 2);
  await f.request("greeting", "PUT", greeting);
  await tick();
  assert.equal(f.previews.length, 2);
  await f.ext.close();
  const restart = f.create();
  await restart.ready;
  await f.request(
    "settings",
    "PUT",
    { enabled: true, token: "secret" },
    restart,
  );
  await tick();
  assert.equal(f.previews.length, 2);
  f.engine.config.voiceProfiles[0].caption = "new";
  assert.equal(await f.bots.at(-1).options.greeting("leave"), null);
  assert.equal(f.previews.length, 2);
  await f.request(
    "settings",
    "PUT",
    { channel: { guildId: A, channelId: A } },
    restart,
  );
  await f.request("connect", "POST", {}, restart);
  await until(() => f.previews.length === 4);
  f.engine.config.provider.baseUrl = "http://new";
  await f.request("connect", "POST", {}, restart);
  await until(() => f.previews.length === 6);
  f.engine.config.voiceProfiles = [];
  assert.equal(await f.bots.at(-1).options.greeting("enter"), null);
});
test("missing dependencies and login failures stay inside extension, secrets not logged", async (t) => {
  const f = setup(t, { installed: false });
  const result = await f.request("settings", "PUT", {
    enabled: true,
    token: "secret",
  });
  assert.equal(result.data.installed, false);
  assert.match(result.data.error, /npm ci/);
  assert.equal(f.calls.length, 0);
  await f.ext.close();
  const broken = f.create({
    installed: true,
    botFactory: async () => {
      throw new Error("secret");
    },
  });
  await broken.ready;
  const status = await f.request("status", "GET", undefined, broken);
  assert.equal(status.data.state, "error");
  assert.doesNotMatch(JSON.stringify(status) + f.logs.join(), /secret/);
});
test("token change logs out before logging in, and close invokes farewell lifecycle", async (t) => {
  const f = setup(t);
  await f.request("settings", "PUT", { enabled: true, token: "first" });
  await f.request("settings", "PUT", { token: "second" });
  assert.deepEqual(f.calls.slice(-2), [["close"], ["login", "second"]]);
  await f.ext.close();
  assert.deepEqual(f.calls.at(-1), ["close"]);
});

test("extension shutdown supplies the cached farewell even after close begins", async (t) => {
  const f = setup(t);
  await f.request("greeting", "PUT", {
    enterText: "",
    leaveText: "お疲れさま",
    voiceProfileId: "voice",
  });
  await until(() => !!f.saved().hashes.leave);
  await f.ext.close();
  let farewell;
  const ext = f.create({
    botFactory: async ({ greeting }) => ({
      status: () => ({ state: "logged-in" }),
      channels: async () => [],
      close: async () => {
        await tick();
        farewell = await greeting("leave");
      },
    }),
  });
  await f.request("settings", "PUT", { enabled: true, token: "secret" }, ext);
  await ext.close();
  assert.ok(Buffer.isBuffer(farewell));
  assert.equal(f.previews.length, 1);
});

test("unselected voice uses the standard narrator; deleted saved voices warn once", async (t) => {
  const f = setup(t);
  await f.request("settings", "PUT", { enabled: true, token: "secret" });
  const { greeting } = f.bots.at(-1).options;
  assert.ok(Buffer.isBuffer(await greeting("enter")));
  await until(() => !!f.saved().hashes.leave);
  assert.ok(Buffer.isBuffer(await greeting("leave")));
  assert.equal(f.previews.length, 2);
  for (const [, voice] of f.previews) {
    assert.equal(voice.voiceId, "none");
    assert.equal(voice.caption, "聞き取りやすい若い女性ナレーターの声");
  }
  assert.equal(f.saved().greeting.voiceProfileId, "");
  assert.equal(f.logs.length, 0);
  await f.request("greeting", "PUT", {
    enterText: "こんにちは",
    leaveText: "さようなら",
    voiceProfileId: "voice",
  });
  await until(() => f.previews.length === 4);
  await tick();
  f.engine.config.voiceProfiles = [];
  for (let i = 0; i < 5; i++) {
    await greeting("enter");
    await greeting("leave");
  }
  assert.equal(
    f.logs.filter((message) => message.includes("声を選んで")).length,
    1,
  );
  assert.match((await f.request("status")).data.error, /声を選んで/);
});

test("greeting status distinguishes unsaved voice, generating, ready, disabled and failed audio", async (t) => {
  const f = setup(t);
  assert.equal(
    (await f.request("status")).data.greetingAudio.enter.state,
    "pending",
  );
  let finish;
  f.engine.preview = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await f.request("greeting", "PUT", {
    enterText: "入室です",
    leaveText: "",
    voiceProfileId: "voice",
  });
  let audio = (await f.request("status")).data.greetingAudio;
  assert.equal(audio.enter.state, "generating");
  assert.equal(audio.leave.state, "disabled");
  finish(mockWav());
  await until(() => !!f.saved().hashes.enter);
  assert.equal(
    (await f.request("status")).data.greetingAudio.enter.state,
    "ready",
  );
  f.engine.preview = async () => {
    throw new Error("TTS HTTP 400: 参照音声が見つかりません");
  };
  await f.request("greeting", "PUT", {
    enterText: "変更しました",
    leaveText: "",
    voiceProfileId: "voice",
  });
  await tick();
  audio = (await f.request("status")).data.greetingAudio;
  assert.equal(audio.enter.state, "error");
  assert.match(audio.enter.error, /参照音声が見つかりません/);
  f.engine.preview = async () => mockWav();
  await f.request("greeting", "PUT", {
    enterText: "変更しました",
    leaveText: "",
    voiceProfileId: "voice",
  });
  await tick();
  assert.equal(
    (await f.request("status")).data.greetingAudio.enter.state,
    "ready",
  );
  f.engine.config.voiceProfiles = [];
  assert.equal(
    (await f.request("status")).data.greetingAudio.enter.state,
    "voice-missing",
  );
});

test("empty voice selection can be saved with message text and can disable either message", async (t) => {
  const f = setup(t);
  await f.request("greeting", "PUT", {
    enterText: "準備できました",
    leaveText: "お疲れさまでした",
    voiceProfileId: "",
  });
  await until(() => Object.keys(f.saved().hashes).length === 2);
  const status = (await f.request("status")).data;
  assert.equal(status.greeting.voiceProfileId, "");
  assert.equal(status.greetingAudio.enter.state, "ready");
  assert.equal(status.greetingAudio.leave.state, "ready");
  assert.equal(status.defaultGreetingVoice.caption, f.previews[0][1].caption);
  await f.request("greeting", "PUT", {
    enterText: "",
    leaveText: "",
    voiceProfileId: "",
  });
  assert.equal(
    (await f.request("status")).data.greetingAudio.enter.state,
    "disabled",
  );
  assert.equal(f.previews.length, 2);
});

test("voice selected for greetings is reported as used even when Bot is disabled", async (t) => {
  const f = setup(t);
  const ext = f.create();
  assert.deepEqual(ext.voiceProfileUses(), {});
  await ext.admin({
    method: "PUT",
    path: "greeting",
    body: { enterText: "こんにちは", leaveText: "", voiceProfileId: "voice" },
  });
  assert.deepEqual(ext.voiceProfileUses(), { voice: ["Discord入退室"] });
});

test("transcription bridge and greeting text are passed to Bot and status includes shared counts without login", async (t) => {
  let count = 12,
    error = "";
  const transcription = {
    ready: () => !error,
    snapshot: () => ({ enabled: true, count, error }),
  };
  const f = setup(t, { transcription });
  assert.deepEqual((await f.request("status")).data.transcription, {
    enabled: true,
    ready: true,
    count: 12,
    error: "",
  });
  await f.request("settings", "PUT", { enabled: true, token: "secret" });
  assert.equal(f.bots[0].options.transcription, transcription);
  assert.equal(
    f.bots[0].options.greetingText("enter"),
    f.saved().greeting.enterText,
  );
  assert.equal(
    f.bots[0].options.greetingText("leave"),
    f.saved().greeting.leaveText,
  );
  count = 15;
  error = "書き出せません";
  assert.deepEqual((await f.request("status")).data.transcription, {
    enabled: true,
    ready: false,
    count: 15,
    error,
  });
});
