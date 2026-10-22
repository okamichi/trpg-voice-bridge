import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, initialConfig } from "../src/store.mjs";
import { Engine } from "../src/engine.mjs";
import { mockWav } from "../src/provider.mjs";
import { VoiceDesign } from "./voice-design.mjs";
import { until } from "./test-helpers.mjs";

const guildId = "11111111111111111",
  channelId = "22222222222222222";
const source = { adapter: "fixture", instanceId: "test", contextId: "room" };
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "voice-design-"));
  const config = initialConfig({});
  config.chatVoiceRegistrationEnabled = true;
  config.sources = [source];
  const store = new Store(dir, config),
    uploads = [],
    generations = [],
    posts = [],
    edits = [],
    errors = [];
  const engine = new Engine(store, {
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/v1/audio/speech")) {
        generations.push(JSON.parse(init.body));
        if (options.generate) await options.generate();
        return new Response(mockWav());
      }
      if (init.method === "POST") {
        uploads.push(Buffer.from(await init.body.get("file").arrayBuffer()));
        return Response.json(
          { id: init.body.get("voice_id") },
          { status: 201 },
        );
      }
      return Response.json({
        data: Array.from({ length: 28 }, (_, i) => ({ id: `ref-${i}` })),
      });
    },
  });
  const client = new EventEmitter();
  client.isReady = () => true;
  const message = {
    id: "33333333333333333",
    edit: async (data) => {
      if (options.edit) await options.edit(data);
      edits.push(data);
      return message;
    },
  };
  client.channels = {
    fetch: async () => ({
      guildId,
      type: 0,
      send: async (data) => {
        posts.push(data);
        return message;
      },
    }),
  };
  const settings = { enabled: true, guildId, channelId };
  const design = new VoiceDesign({
    client,
    engine,
    settings: () => settings,
    report: (e) => errors.push(e),
    ttl: options.ttl,
  });
  engine.chatVoices.designer = {
    enabled: () => settings.enabled,
    run: (task, valid) => design.open(task, valid),
  };
  engine.connect({ source, collectorId: "collector" });
  let sequence = 0;
  const send = (
    text = "（ブリッジ声登録）イケオジボイス。",
    actor = "alfred",
  ) => {
    const n = ++sequence;
    return engine.ingress(
      {
        schemaVersion: 1,
        eventId: `event${n}`,
        roomId: config.roomId,
        sessionId: engine.sessionId,
        source: { ...source, messageId: `message${n}`, revision: 0 },
        speaker: { kind: "character", id: actor, name: actor },
        channel: "main",
        kind: "dialogue",
        visibility: "public",
        text,
        occurredAt: new Date().toISOString(),
      },
      "collector",
    );
  };
  t.after(async () => {
    design.close();
    engine.close();
    await engine.references.close();
    await engine.chatVoices.drain();
    while (engine.busy) await new Promise((r) => setTimeout(r, 5));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ready = async (id) => {
    await until(
      () =>
        design.sessions.get(id)?.published &&
        !design.sessions.get(id)?.operating,
    );
    return design.sessions.get(id);
  };
  const act = async (s, action, extra = {}) => {
    const replies = [];
    const i = {
      customId: design.id(s, action),
      guildId,
      channelId,
      message,
      user: { id: "44444444444444444" },
      fields: {
        getTextInputValue: (key) => String(extra.fields?.[key] ?? ""),
        getStringSelectValues: () => extra.values ?? [],
      },
      deferReply: async () => {
        i.deferred = true;
      },
      deferUpdate: async () => {
        i.deferred = true;
      },
      deleteReply: async () => replies.push({ deleted: true }),
      editReply: async (data) => replies.push(data),
      reply: async (data) => replies.push(data),
      showModal: async (data) => replies.push(data),
      ...extra,
    };
    if (extra.fields)
      i.fields = {
        getTextInputValue: (key) => String(extra.fields[key] ?? ""),
      };
    await design.handle(i);
    return replies;
  };
  return {
    store,
    engine,
    design,
    settings,
    send,
    ready,
    act,
    posts,
    edits,
    uploads,
    generations,
    errors,
  };
}

test("VTT starts one post, edits and regenerates in place, confirms exactly the published WAV", async (t) => {
  const f = setup(t);
  const job = f.send();
  const s = await f.ready(job.orderId);
  assert.equal(f.posts.length, 1);
  assert.equal(s.sample, "これからこの声でお話しします。");
  assert.equal(f.uploads.length, 0);
  assert.equal(f.store.config.characters[0].voiceProfileId, null);
  assert.equal(f.store.voiceCommands.get(job.orderId).status, "designing");
  assert.equal(f.send().status, "rejected");
  const old = f.design.id(s, "confirm");
  const modal = (await f.act(s, "basic"))[0];
  assert.equal(modal.components.length, 4);
  await f.act(s, "basicSave", {
    fields: {
      name: "渋い声",
      caption: "低い声 @everyone <script>",
      speed: "0.85",
      sample: "お待たせしました。",
    },
  });
  assert.equal(s.dirty, true);
  assert.equal(s.wav, null);
  assert.match((await f.act(s, "confirm"))[0].content, /再生成/);
  assert.match(
    (await f.act(s, "confirm", { customId: old }))[0].content,
    /古い/,
  );
  await f.act(s, "advancedSave", {
    fields: {
      seed: "9223372036854775807",
      steps: "25",
      cfgScaleText: "2",
      cfgScaleCaption: "",
      cfgScaleSpeaker: "0",
    },
  });
  assert.equal(s.voice.seed, "9223372036854775807");
  assert.equal(s.voice.cfgScaleText, 2);
  assert.equal(s.voice.cfgScaleCaption, undefined);
  await f.act(s, "generate");
  const wav = s.wav;
  assert.equal(f.generations.length, 2);
  assert.equal(f.posts.length, 1);
  const attached = f.edits.filter((e) => e.files?.length);
  assert.equal(attached.length, 2);
  assert.deepEqual(attached[1].files[0].attachment, wav);
  assert.deepEqual(attached[1].attachments, []);
  assert.deepEqual(attached[1].allowedMentions, { parse: [] });
  await f.act(s, "confirm");
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 1);
  assert.deepEqual(f.uploads[0], wav);
  assert.equal(f.store.voiceCommands.get(job.orderId).status, "completed");
  assert.ok(f.store.config.characters[0].voiceProfileId);
  assert.equal(f.generations.length, 2);
  assert.deepEqual(f.edits.at(-1).components, []);
  assert.equal(f.design.sessions.size, 0);
});

test("foreign channel, invalid input, stale modal and duplicate confirmation do not mutate voice", async (t) => {
  const f = setup(t),
    job = f.send(),
    s = await f.ready(job.orderId);
  assert.match(
    (await f.act(s, "confirm", { channelId: "other" }))[0].content,
    /チャンネル/,
  );
  const before = structuredClone(s.voice);
  await f.act(s, "advancedSave", {
    fields: { seed: "9223372036854775808", steps: "20" },
  });
  assert.deepEqual(s.voice, before);
  await Promise.all([f.act(s, "confirm"), f.act(s, "confirm")]);
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 1);
});

test("reference choice pagination and explicit seed editing", async (t) => {
  const f = setup(t),
    s = await f.ready(f.send().orderId);
  const menu = (await f.act(s, "refs1"))[0];
  assert.equal(menu.components[0].component.options.length, 6);
  await f.act(s, "refsSelect", {
    values: [menu.components[0].component.options[4].value],
  });
  assert.equal(s.voice.voiceId, "ref-27");
  const seed = s.voice.seed;
  await f.act(s, "advancedSave", {
    fields: {
      seed: "2",
      steps: String(s.voice.steps),
      cfgScaleText: s.voice.cfgScaleText ?? "",
      cfgScaleCaption: s.voice.cfgScaleCaption ?? "",
      cfgScaleSpeaker: s.voice.cfgScaleSpeaker ?? "",
    },
  });
  await f.act(s, "generate");
  assert.notEqual(s.voice.seed, seed);
  assert.equal(f.posts.length, 1);
  await f.act(s, "cancel");
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 0);
});

test("解除 alias cancels a draft; disabled mode preserves immediate registration", async (t) => {
  const f = setup(t),
    s = await f.ready(f.send().orderId);
  assert.equal(f.send("（ブリッジ声解除）").status, "completed");
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 0);
  assert.match((await f.act(s, "confirm"))[0].content, /期限切れ/);
  f.settings.enabled = false;
  f.send();
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.posts.length, 1);
});

test("expiry and bot shutdown release active registrations without replacing an existing voice", async (t) => {
  const f = setup(t, { ttl: 150 });
  f.settings.enabled = false;
  f.send();
  await until(() => !f.engine.chatVoices.tasks.size);
  const saved = f.store.config.characters[0].voiceProfileId;
  f.settings.enabled = true;
  const job = f.send();
  await f.ready(job.orderId);
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.store.config.characters[0].voiceProfileId, saved);
  assert.equal(f.store.voiceCommands.get(job.orderId).status, "failed");
  await f.ready(f.send().orderId);
  f.design.close();
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.store.config.characters[0].voiceProfileId, saved);
});

test("attachment upload failure never makes the candidate confirmable; retry can recover", async (t) => {
  let reject = true;
  const f = setup(t, {
    edit: async (data) => {
      if (reject && data.files?.length) throw new Error("upload failed");
    },
  });
  const job = f.send();
  await until(
    () => f.store.voiceCommands.get(job.orderId)?.status === "designing",
  );
  const s = f.design.sessions.get(job.orderId);
  assert.equal(s.wav, null);
  assert.match((await f.act(s, "confirm"))[0].content, /再生成/);
  reject = false;
  await f.act(s, "generate");
  assert.ok(s.published);
  await f.act(s, "confirm");
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.equal(f.uploads.length, 1);
});

test("cancel during upload leaves the final post disabled and without stale audio", async (t) => {
  let block = false,
    started = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = setup(t, {
    edit: async (data) => {
      if (block && data.files?.length) {
        started = true;
        await gate;
      }
    },
  });
  const s = await f.ready(f.send().orderId);
  block = true;
  await f.act(s, "advancedSave", { fields: { seed: "2", steps: "20" } });
  const generating = f.act(s, "generate");
  await until(() => started);
  await f.act(s, "cancel");
  release();
  await generating;
  await until(() => !f.engine.chatVoices.tasks.size);
  assert.deepEqual(f.edits.at(-1).components, []);
  assert.deepEqual(f.edits.at(-1).attachments, []);
  assert.equal(f.edits.at(-1).files, undefined);
  assert.equal(f.uploads.length, 0);
});

test("draft capacity is bounded and failed admission does not post or register", async (t) => {
  const f = setup(t);
  for (let i = 0; i < 4; i++)
    await f.ready(f.send(undefined, `actor-${i}`).orderId);
  const extra = f.send(undefined, "extra");
  await until(
    () => f.store.voiceCommands.get(extra.orderId)?.status === "failed",
  );
  assert.equal(f.design.sessions.size, 4);
  assert.equal(f.posts.length, 4);
  assert.equal(f.uploads.length, 0);
  f.design.cancel();
  await until(() => !f.engine.chatVoices.tasks.size);
});

test("voice selectors open cancelable modals without changing a published candidate", async (t) => {
  const f = setup(t),
    s = await f.ready(f.send().orderId);
  const wav = s.wav,
    version = s.version,
    voice = structuredClone(s.voice);
  for (const action of ["voices0", "refs0"]) {
    const modal = (await f.act(s, action))[0];
    assert.ok(modal.title);
    assert.equal(modal.components[0].type, 18);
    assert.equal(modal.components[0].component.type, 3);
    assert.match(modal.components[0].description, /キャンセル/);
  }
  assert.equal(s.wav, wav);
  assert.equal(s.version, version);
  assert.equal(s.dirty, false);
  assert.deepEqual(s.voice, voice);
  const prompt = (await f.act(s, "refsSelect", { values: ["page-1"] }))[0];
  assert.equal(prompt.components[0].components[1].label, "閉じる");
  assert.deepEqual(await f.act(s, "closePicker"), [{ deleted: true }]);
  assert.equal(s.version, version);
  assert.equal(s.wav, wav);
});

test("unchanged settings do not regenerate; seed changes require explicit editing", async (t) => {
  const f = setup(t),
    s = await f.ready(f.send().orderId);
  const generationButton = () =>
    f.design.payload(s).components[1].components[0];
  assert.equal(generationButton().label, "変更を反映し再生声");
  assert.equal(generationButton().disabled, true);
  await f.act(s, "generate");
  assert.equal(f.generations.length, 1);
  const fields = {
    name: s.voice.name,
    caption: s.voice.caption,
    speed: String(s.voice.speed),
    sample: s.sample,
  };
  await f.act(s, "basicSave", { fields });
  assert.equal(s.dirty, false);
  await f.act(s, "basicSave", {
    fields: { ...fields, caption: "もっと落ち着いた声" },
  });
  assert.equal(generationButton().disabled, false);
  const seed = s.voice.seed;
  await f.act(s, "generate");
  assert.equal(s.voice.seed, seed);
  assert.equal(f.generations.length, 2);
  assert.equal(generationButton().disabled, true);
  const voice = structuredClone(s.voice);
  await f.act(s, "advancedSave", {
    fields: {
      seed: "2",
      steps: String(s.voice.steps),
      cfgScaleText: s.voice.cfgScaleText ?? "",
      cfgScaleCaption: s.voice.cfgScaleCaption ?? "",
      cfgScaleSpeaker: s.voice.cfgScaleSpeaker ?? "",
    },
  });
  await f.act(s, "generate");
  assert.notEqual(s.voice.seed, seed);
  assert.deepEqual({ ...s.voice, seed }, voice);
});

test("audio placeholder switches from waiting to generating and is replaced by the attachment", async (t) => {
  let release,
    started = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = setup(t, {
    generate: async () => {
      started = true;
      await gate;
    },
  });
  t.after(() => release());
  const job = f.send();
  await until(
    () => started && f.edits.some((e) => e.content.includes("音声を生成中")),
  );
  assert.match(f.posts[0].content, /生成準備中/);
  assert.equal(f.posts[0].files, undefined);
  assert.ok(f.edits.some((e) => e.content.includes("生成待ち")));
  const progress = f.edits.at(-1);
  assert.match(progress.content, /<t:\d+:R>/);
  assert.equal(progress.files, undefined);
  assert.equal(
    progress.components
      .flatMap((r) => r.components)
      .some((b) => b.custom_id.endsWith(":another")),
    false,
  );
  release();
  await f.ready(job.orderId);
  assert.doesNotMatch(f.edits.at(-1).content, /⏳|⚙️/);
  assert.equal(f.edits.at(-1).files.length, 1);
});

for (const accepting of [true, false]) {
  test(`Discord confirmation stays silent while reading is ${accepting ? "active" : "stopped"}; immediate registration keeps its confirmation`, async (t) => {
    const f = setup(t);
    f.engine.accepting = accepting;
    const notifications = [];
    f.engine.on("notification", (event) => notifications.push(event));
    const job = f.send();
    const s = await f.ready(job.orderId);
    await f.act(s, "confirm");
    await until(() => !f.engine.chatVoices.tasks.size);
    assert.equal(f.store.voiceCommands.get(job.orderId).status, "completed");
    assert.equal(f.store.voiceCommands.get(job.orderId).unplayed, false);
    assert.equal(f.engine.audio.size, 0);
    assert.equal(f.engine.orders.size, 0);
    assert.equal(
      notifications.filter((n) => n.type === "audio.ready").length,
      0,
    );
    assert.match(f.edits.at(-1).content, /この声を登録しました/);
    assert.equal(f.uploads.length, 1);

    f.settings.enabled = false;
    const immediate = f.send(undefined, "another-character");
    await until(() => !f.engine.chatVoices.tasks.size);
    assert.equal(
      f.store.voiceCommands.get(immediate.orderId).unplayed,
      !accepting,
    );
    assert.equal(
      notifications.filter((n) => n.type === "audio.ready").length,
      accepting ? 1 : 0,
    );
    assert.equal(f.uploads.length, 2);
  });
}
