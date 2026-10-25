import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockWav, synthesize, inspectWav } from "./provider.mjs";
import { ReferenceVoices } from "./reference-voices.mjs";
import { ReferenceStore } from "./reference-store.mjs";
import { uploadVoice } from "./tts-api.mjs";

const provider = {
  type: "speech",
  baseUrl: "http://127.0.0.1:18088",
  model: "irodori-tts",
};
const voice = {
  id: "test",
  name: "test",
  provider: "irodori-local",
  voiceId: "none",
  caption: "明るい声",
  seed: "9223372036854775807",
  speed: 1,
  steps: 4,
};
const info = (names = ["none"]) => ({
  id: "Irodori-TTS-v4.1-Anime",
  object: "model",
  speech: {
    task: "synthesis",
    voices: names.map((name) => ({ name })),
    options: [
      "instructions",
      "speed",
      "steps",
      "seed",
      "voice",
      "cfg_scale_text",
      "cfg_scale_speaker",
      "cfg_scale_instructions",
    ].map((name) => ({ name })),
  },
});
const pcm = (bytes = Buffer.alloc(4800)) =>
  new Response(bytes, { headers: { "X-Sample-Rate": "24000" } });
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "speech-compatible-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("native speech uses discovered model, exact seed reduction and active supported CFG; PCM becomes WAV", async () => {
  const requests = [];
  const wav = await synthesize(
    "こんにちは",
    { ...voice, cfgScaleText: 2, cfgScaleCaption: 3, cfgScaleSpeaker: 4 },
    provider,
    {
      fetchImpl: async (url, request) => {
        if (url.endsWith("/v1/models"))
          return Response.json({ data: [info()] });
        requests.push(JSON.parse(request.body));
        return pcm();
      },
    },
  );
  assert.deepEqual(requests, [
    {
      model: info().id,
      input: "こんにちは",
      voice: "none",
      response_format: "pcm",
      speed: 1,
      steps: 4,
      seed: Number.MAX_SAFE_INTEGER,
      instructions: "明るい声",
      cfg_scale_text: 2,
      cfg_scale_instructions: 3,
    },
  ]);
  assert.equal(inspectWav(wav).durationMs, 100);
  await synthesize("こんにちは", { ...voice, voiceId: "no_ref" }, provider, {
    model: info(),
    fetchImpl: async (_url, request) => {
      assert.equal(JSON.parse(request.body).voice, "none");
      return pcm();
    },
  });
  for (const [caption, options, expected] of [
    ["", info().speech.options, undefined],
    [
      "明るい声",
      info().speech.options.filter((o) => !o.name.startsWith("cfg_")),
      undefined,
    ],
  ]) {
    const model = info();
    model.speech.options = options;
    await synthesize(
      "こんにちは",
      { ...voice, caption, cfgScaleCaption: 4 },
      provider,
      {
        model,
        fetchImpl: async (_url, request) => {
          assert.equal(
            JSON.parse(request.body).cfg_scale_instructions,
            expected,
          );
          return pcm();
        },
      },
    );
  }
  await assert.rejects(
    synthesize("こんにちは", voice, provider, { model: info([]) }),
    /参照音声/,
  );
});

test("native PCM stops at 120 seconds and cancels; broken streams never become successful partial WAVs", async () => {
  let cancelled = false;
  const wav = await synthesize("長文", voice, provider, {
    model: info(),
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "X-Sample-Rate": "24000" } },
      ),
  });
  assert.equal(inspectWav(wav).durationMs, 120000);
  assert.ok(cancelled);
  let reads = 0;
  await assert.rejects(
    synthesize("長文", voice, provider, {
      model: info(),
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (reads++) controller.error(new Error("broken stream"));
              else controller.enqueue(new Uint8Array(10));
            },
          }),
          { headers: { "X-Sample-Rate": "24000" } },
        ),
    }),
    (e) =>
      /音声受信が途中で中断/.test(e.message) &&
      e.cause?.message === "broken stream",
  );
});

test("input range rejection is bisected on Unicode boundaries without depending on English wording", async () => {
  const inputs = [];
  const input = "あ😀い😀";
  const wav = await synthesize(input, voice, provider, {
    model: info(),
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      inputs.push(body.input);
      if (body.input === input)
        return Response.json(
          {
            error: {
              param: "input",
              code: "unsupported_value",
              message: "the text's speech is predicted to last 36.1021 s",
            },
          },
          { status: 400 },
        );
      return pcm();
    },
  });
  assert.deepEqual(inputs, [input, "あ😀", "い😀"]);
  assert.equal(inspectWav(wav).durationMs, 200);
  let attempts = 0;
  await assert.rejects(
    synthesize(input, voice, provider, {
      model: info(),
      fetchImpl: async () => {
        attempts++;
        return Response.json(
          {
            error: {
              param: "instructions",
              message:
                "the instructions are 200 tokens long and takes at most 150",
            },
          },
          { status: 400 },
        );
      },
    }),
    /演技指示.*短く/,
  );
  assert.equal(attempts, 1);
});

function server(type) {
  const names = new Set(["none", "external"]),
    uploads = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "POST") {
      assert.ok(
        url.endsWith(type === "speech" ? "/speech/voices" : "/v1/audio/voices"),
      );
      const name = init.body.get(type === "speech" ? "name" : "voice_id");
      uploads.push({
        name,
        wav: Buffer.from(await init.body.get("file").arrayBuffer()),
      });
      assert.ok(!names.has(name), "duplicate upload");
      names.add(name);
      return type === "speech"
        ? Response.json({ held: {} })
        : Response.json({ id: name, object: "voice_file" }, { status: 201 });
    }
    assert.ok(
      url.endsWith(type === "speech" ? "/v1/models" : "/v1/audio/voices"),
    );
    return Response.json(
      type === "speech"
        ? { data: [info([...names])] }
        : { data: [...names].map((id) => ({ id, no_ref: id === "none" })) },
    );
  };
  return { names, uploads, fetchImpl };
}

for (const type of ["speech", "irodori"])
  test(`${type}: persist original WAV, restore after restart, retain native voices and avoid repeated uploads`, async (t) => {
    const dir = temp(t),
      remote = server(type),
      p = { ...provider, type },
      original = mockWav();
    let refs = new ReferenceVoices(remote.fetchImpl, dir);
    await refs.register({ provider: p, voiceId: "saved", wav: original });
    assert.deepEqual(readFileSync(join(dir, "voices/saved.wav")), original);
    const list = await refs.list(p);
    assert.deepEqual(
      list.find((v) => v.id === "none"),
      { id: "none", no_ref: true },
    );
    assert.ok(list.some((v) => v.id === "external"));
    assert.equal(remote.uploads.length, 1);
    await refs.close();
    remote.names.delete("saved"); // TTS-only restart or changing the loaded model.
    refs = new ReferenceVoices(remote.fetchImpl, dir);
    t.after(() => refs.close());
    await Promise.all([
      refs.prepare(p, undefined, "saved"),
      refs.prepare(p, undefined, "saved"),
    ]);
    assert.equal(remote.uploads.length, 2);
    assert.deepEqual(remote.uploads[1].wav, original);
    assert.deepEqual(Object.keys(new ReferenceStore(dir).entries()), ["saved"]);
    const otherType = type === "speech" ? "irodori" : "speech";
    const other = server(otherType);
    const otherRefs = new ReferenceVoices(other.fetchImpl, dir);
    await otherRefs.prepare({ ...p, type: otherType }, undefined, "saved");
    assert.deepEqual(other.uploads[0].wav, original);
    await otherRefs.close();
  });

test("listing restored voices remains available during another upload and close aborts that upload", async (t) => {
  const dir = temp(t),
    remote = server("speech");
  const refs = new ReferenceVoices(remote.fetchImpl, dir);
  t.after(() => refs.close());
  await refs.register({ provider, voiceId: "saved", wav: mockWav() });
  let started;
  const uploading = new Promise((resolve) => {
    started = resolve;
  });
  refs.fetch = async (url, init) => {
    if (init?.method !== "POST") return remote.fetchImpl(url, init);
    started();
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true,
      }),
    );
  };
  const pending = refs.register({
    provider,
    voiceId: "pending",
    wav: mockWav(),
    wait: true,
  });
  const rejected = assert.rejects(pending, /中断/);
  await uploading;
  const list = await refs.list(provider, AbortSignal.timeout(1000));
  assert.ok(list.some((v) => v.id === "saved"));
  assert.ok(!list.some((v) => v.id === "pending"));
  await refs.close();
  await rejected;
});

test("fork WAV migration and upload failures retain originals; unknown name collisions never overwrite or silently adopt", async (t) => {
  const dir = temp(t),
    store = new ReferenceStore(dir),
    remote = server("speech");
  writeFileSync(join(dir, "voices/legacy.wav"), mockWav());
  const refs = new ReferenceVoices(remote.fetchImpl, dir);
  t.after(() => refs.close());
  await refs.prepare(provider);
  assert.equal(remote.uploads[0].name, "legacy");
  store.save("external", mockWav());
  await assert.rejects(refs.prepare(provider, undefined, "external"), /衝突/);
  assert.equal(remote.uploads.length, 1);
  const failing = new ReferenceVoices(async (url, init) => {
    if (init?.method === "POST") throw Error("network lost");
    return remote.fetchImpl(url, init);
  }, dir);
  await assert.rejects(
    failing.register({ provider, voiceId: "retry", wav: mockWav() }),
    /network lost/,
  );
  await failing.close();
  assert.deepEqual(store.wav("retry"), mockWav());
  await refs.prepare(provider, undefined, "retry");
  assert.ok(remote.names.has("retry"));
  // IDs that happen to be JavaScript property names remain ordinary IDs.
  store.save("__proto__", mockWav());
  assert.ok(Object.hasOwn(store.entries(), "__proto__"));
  assert.throws(() => store.save("../outside", mockWav()), /ID/);
  writeFileSync(join(dir, "voices/retry.wav"), mockWav(0.2));
  remote.names.delete("retry");
  await assert.rejects(
    refs.prepare(provider, undefined, "retry"),
    /変更されています/,
  );
});

test("native duplicate, validation and private-route errors are distinguished", async () => {
  for (const [status, error, expected, code] of [
    [
      400,
      {
        param: "name",
        code: "invalid_value",
        message:
          "rv1 is already a voice of Irodori-TTS-v4.1-Small; give the voice another name",
      },
      /同じID/,
      409,
    ],
    [
      400,
      {
        param: "name",
        code: "invalid_value",
        message: "name must not be empty",
      },
      /HTTP 400/,
      502,
    ],
    [403, { code: "host_not_allowed" }, /同じポート/, 502],
    [404, { code: "page_off" }, /127.0.0.1/, 502],
  ])
    await assert.rejects(
      uploadVoice(provider, "saved", mockWav(), async () =>
        Response.json({ error }, { status }),
      ),
      (e) => e.status === code && expected.test(e.message),
    );
});

test("failed upload and unknown collisions do not poison listing; startup continues and selected voices still fail", async (t) => {
  const dir = temp(t),
    remote = server("speech");
  let posts = 0;
  const refs = new ReferenceVoices(async (url, init) => {
    if (init?.method === "POST" && init.body.get("name") === "bad") {
      posts++;
      return Response.json({ error: { code: "page_off" } }, { status: 404 });
    }
    return remote.fetchImpl(url, init);
  }, dir);
  t.after(() => refs.close());
  await assert.rejects(
    refs.register({ provider, voiceId: "bad", wav: mockWav() }),
    /127.0.0.1/,
  );
  assert.ok(!Object.hasOwn(refs.store.read().voices, "bad"));
  // An already saved backup is never removed by a later restore failure.
  refs.store.save("bad", mockWav());
  refs.store.save("good", mockWav());
  refs.store.save("external", mockWav());
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      (await refs.list(provider)).map((v) => v.id),
      ["none"],
    );
  assert.equal(posts, 1, "listing must never retry uploads");
  await refs.prepare(provider); // partial restoration is a usable startup
  assert.ok(remote.names.has("good"));
  assert.deepEqual(
    new Set((await refs.list(provider)).map((v) => v.id)),
    new Set(["none", "good"]),
  );
  assert.equal(
    refs.diagnostics(provider).find((p) => p.id === "external").kind,
    "conflict",
  );
  await refs.prepare(provider, undefined, "good");
  await assert.rejects(refs.prepare(provider, undefined, "bad"), /127.0.0.1/);
  await assert.rejects(refs.prepare(provider, undefined, "external"), /衝突/);
});

test("missing, corrupt imported and changed managed WAVs are isolated and can be repaired", async (t) => {
  const dir = temp(t),
    remote = server("speech"),
    refs = new ReferenceVoices(remote.fetchImpl, dir);
  t.after(() => refs.close());
  refs.store.save("deleted", mockWav());
  refs.store.save("changed", mockWav());
  refs.store.save("good", mockWav());
  unlinkSync(join(dir, "voices/deleted.wav"));
  writeFileSync(join(dir, "voices/broken.wav"), "not wav");
  writeFileSync(join(dir, "voices/changed.wav"), mockWav(0.2));
  await refs.prepare(provider);
  assert.deepEqual(
    remote.uploads.map((u) => u.name),
    ["good"],
  );
  assert.deepEqual(
    new Set(refs.diagnostics(provider).map((p) => p.id)),
    new Set(["deleted", "changed", "broken"]),
  );
  assert.ok((await refs.list(provider)).some((v) => v.id === "good"));
  await refs.prepare(provider, undefined, "none");
  await assert.rejects(
    refs.prepare(provider, undefined, "deleted"),
    /WAVがありません/,
  );
  await assert.rejects(
    refs.prepare(provider, undefined, "broken"),
    /読み込めません/,
  );
  writeFileSync(join(dir, "voices/deleted.wav"), mockWav());
  writeFileSync(join(dir, "voices/changed.wav"), mockWav());
  writeFileSync(join(dir, "voices/broken.wav"), mockWav());
  await refs.prepare(provider);
  assert.deepEqual(refs.diagnostics(provider), []);
  assert.ok(remote.names.has("deleted"));
});

test("URL alias and lost upload response require explicit adoption, persist it and never reupload", async (t) => {
  const dir = temp(t),
    remote = server("irodori"),
    p = { ...provider, type: "irodori" };
  let refs = new ReferenceVoices(remote.fetchImpl, dir);
  await refs.register({ provider: p, voiceId: "saved", wav: mockWav() });
  const alias = { ...p, baseUrl: "http://localhost:18088" };
  assert.ok(!(await refs.list(alias)).some((v) => v.id === "saved"));
  const issue = refs.diagnostics(alias).find((p) => p.id === "saved");
  assert.equal(issue.kind, "conflict");
  await assert.rejects(refs.adopt(alias, "saved", "stale"), /変更されています/);
  refs.fetch = async (url, init) => {
    const response = await remote.fetchImpl(url, init);
    writeFileSync(join(dir, "voices/saved.wav"), mockWav(0.2));
    return response;
  };
  await assert.rejects(
    refs.adopt(alias, "saved", issue.sha256),
    /変更されています/,
  );
  assert.equal(refs.store.bound("saved", alias), false);
  writeFileSync(join(dir, "voices/saved.wav"), mockWav());
  refs.fetch = remote.fetchImpl;
  await refs.adopt(alias, "saved", issue.sha256);
  await refs.close();
  refs = new ReferenceVoices(remote.fetchImpl, dir);
  t.after(() => refs.close());
  await refs.prepare(alias, undefined, "saved");
  assert.equal(remote.uploads.length, 1);
  refs.fetch = async (url, init) => {
    const response = await remote.fetchImpl(url, init);
    if (init?.method === "POST") throw Error("response lost");
    return response;
  };
  await assert.rejects(
    refs.register({ provider: alias, voiceId: "lost", wav: mockWav() }),
    /response lost/,
  );
  assert.ok((await refs.list(alias)).some((v) => v.id === "saved"));
  const lost = refs.diagnostics(alias).find((p) => p.id === "lost");
  assert.equal(lost.kind, "conflict");
  await refs.adopt(alias, "lost", lost.sha256);
  assert.equal(remote.uploads.length, 2);
});

test("input validation is not retried and cancellation is not relabeled as a stream failure", async () => {
  let attempts = 0;
  await assert.rejects(
    synthesize("x", voice, provider, {
      model: info(),
      fetchImpl: async () => {
        attempts++;
        return Response.json(
          {
            error: {
              param: "input",
              code: "invalid_value",
              message: "invalid input",
            },
          },
          { status: 400 },
        );
      },
    }),
    /HTTP 400/,
  );
  assert.equal(attempts, 1);
  const controller = new AbortController();
  const reason = new Error("user cancelled");
  await assert.rejects(
    synthesize("x", voice, provider, {
      model: info(),
      signal: controller.signal,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              controller.abort(reason);
              c.error(reason);
            },
          }),
          { headers: { "X-Sample-Rate": "24000" } },
        ),
    }),
    (e) => e === reason,
  );
});

test("known upload refusal rolls back only the new save, frees its ID and cannot resurrect it later", async (t) => {
  const dir = temp(t),
    remote = server("speech");
  let refuse = true;
  const refs = new ReferenceVoices(async (url, init) => {
    if (refuse && init?.method === "POST")
      return Response.json({ error: { code: "page_off" } }, { status: 404 });
    return remote.fetchImpl(url, init);
  }, dir);
  t.after(() => refs.close());
  await assert.rejects(
    refs.register({ provider, voiceId: "new", wav: mockWav() }),
    /127.0.0.1/,
  );
  await refs.running;
  assert.ok(!existsSync(join(dir, "voices/new.wav")));
  assert.ok(!Object.hasOwn(refs.store.read().voices, "new"));
  assert.deepEqual(refs.diagnostics(provider), []);
  refuse = false;
  await refs.prepare(provider);
  assert.equal(remote.uploads.length, 0);
  await refs.register({ provider, voiceId: "new", wav: mockWav(0.2) });
  await refs.running;
  assert.deepEqual(refs.store.wav("new"), mockWav(0.2));
  // A backup owned before this registration is preserved on rejection.
  refs.store.save("existing", mockWav());
  refuse = true;
  await assert.rejects(
    refs.register({ provider, voiceId: "existing", wav: mockWav() }),
    /127.0.0.1/,
  );
  assert.deepEqual(refs.store.wav("existing"), mockWav());
});

test("HTTP status alone never authorizes rollback; native refusals and Irodori duplicates are distinguished", async (t) => {
  for (const [type, status, problem, discard] of [
    ["speech", 403, { code: "host_not_allowed" }, true],
    ["speech", 400, { code: "invalid_value", param: "name" }, true],
    ["speech", 409, { code: "model_not_found" }, true],
    ["irodori", 409, { code: "voice_exists" }, true],
    ["speech", 500, { code: "page_off" }, false],
    ["speech", 502, { code: "upstream_error" }, false],
    ["speech", 404, null, false],
    ["speech", 400, { code: "unknown_error" }, false],
  ]) {
    const dir = temp(t),
      remote = server(type),
      p = { ...provider, type };
    const refs = new ReferenceVoices(
      async (url, init) =>
        init?.method === "POST"
          ? Response.json({ error: problem }, { status })
          : remote.fetchImpl(url, init),
      dir,
    );
    await assert.rejects(
      refs.register({ provider: p, voiceId: "test", wav: mockWav() }),
    );
    assert.equal(
      existsSync(join(dir, "voices/test.wav")),
      !discard,
      `${type} ${status}`,
    );
    assert.equal(Object.hasOwn(refs.store.read().voices, "test"), !discard);
    await refs.close();
  }
});

test("detach clears missing warnings and all bindings, permits reuse after server removal, and archives remaining audio", async (t) => {
  const dir = temp(t),
    remote = server("speech"),
    refs = new ReferenceVoices(remote.fetchImpl, dir);
  t.after(() => refs.close());
  await refs.register({ provider, voiceId: "saved", wav: mockWav() });
  await refs.running;
  refs.store.bind("saved", { ...provider, baseUrl: "http://localhost:9999" });
  unlinkSync(join(dir, "voices/saved.wav"));
  const [issue] = refs.diagnostics(provider);
  await assert.rejects(
    refs.register({
      provider: { ...provider, baseUrl: "http://localhost:9999" },
      voiceId: "saved",
      wav: mockWav(0.2),
    }),
    /既にあります/,
  );
  await refs.running;
  await assert.rejects(refs.forget("saved", "stale"), /変更されています/);
  await refs.forget("saved", issue.sha256);
  assert.deepEqual(refs.diagnostics(provider), []);
  assert.ok(remote.names.has("saved"), "detach does not delete remote audio");
  assert.ok(
    (await refs.list(provider)).some((v) => v.id === "saved"),
    "detached server audio remains selectable as an external voice",
  );
  await assert.rejects(
    refs.register({ provider, voiceId: "saved", wav: mockWav(0.2) }),
    /既にあります/,
  );
  await refs.running;
  remote.names.delete("saved");
  await refs.register({ provider, voiceId: "saved", wav: mockWav(0.2) });
  await refs.running;
  assert.equal(
    refs.store.bound("saved", {
      ...provider,
      baseUrl: "http://localhost:9999",
    }),
    false,
  );
  const sha = refs.store.read().voices.saved.sha256;
  await refs.forget("saved", sha);
  assert.ok(!existsSync(join(dir, "voices/saved.wav")));
  const files = readdirSync(join(dir, "voices-detached"));
  assert.equal(files.length, 1);
  assert.deepEqual(
    readFileSync(join(dir, "voices-detached", files[0])),
    mockWav(0.2),
  );
  assert.ok(
    !Object.hasOwn(refs.store.entries(), "saved"),
    "archived WAV is not re-imported",
  );
});

for (const type of ["irodori", "speech"])
  test(`${type}: missing backup warns but known remote audio remains usable until the server loses it`, async (t) => {
    const dir = temp(t),
      remote = server(type),
      p = { ...provider, type };
    let refs = new ReferenceVoices(remote.fetchImpl, dir);
    await refs.register({ provider: p, voiceId: "saved", wav: mockWav() });
    await refs.close();
    unlinkSync(join(dir, "voices/saved.wav"));
    refs = new ReferenceVoices(remote.fetchImpl, dir);
    t.after(() => refs.close());
    assert.ok((await refs.list(p)).some((v) => v.id === "saved"));
    assert.ok(
      (await refs.prepare(p, undefined, "saved")).voices.some(
        (v) => v.id === "saved",
      ),
    );
    assert.equal(refs.diagnostics(p)[0].kind, "missing");
    assert.equal(remote.uploads.length, 1);
    await assert.rejects(
      refs.prepare(
        { ...p, baseUrl: "http://localhost:9999" },
        undefined,
        "saved",
      ),
      /WAVがありません/,
    );
    remote.names.delete("saved");
    assert.ok(!(await refs.list(p)).some((v) => v.id === "saved"));
    await assert.rejects(
      refs.prepare(p, undefined, "saved"),
      /WAVがありません/,
    );
  });

test("corrupt ledger yields one diagnostic, preserves original bytes and cannot be overwritten through registration", async (t) => {
  const dir = temp(t),
    refs = new ReferenceVoices(server("speech").fetchImpl, dir);
  t.after(() => refs.close());
  for (const content of ["{ broken", "null", '{"version":2,"voices":{}}']) {
    writeFileSync(join(dir, "reference-voices.json"), content);
    const [issue] = refs.diagnostics(provider);
    assert.equal(issue.kind, "ledger");
    assert.match(issue.message, /reference-voices.json/);
    await assert.rejects(
      refs.register({ provider, voiceId: "saved", wav: mockWav() }),
    );
    await refs.running;
    assert.equal(
      readFileSync(join(dir, "reference-voices.json"), "utf8"),
      content,
    );
  }
  writeFileSync(
    join(dir, "reference-voices.json"),
    '{"version":1,"voices":{}}',
  );
  assert.deepEqual(refs.diagnostics(provider), []);
});

test("restoration queued behind detach rechecks the ledger and never reimports or uploads the detached WAV", async (t) => {
  const dir = temp(t),
    remote = server("speech"),
    refs = new ReferenceVoices(remote.fetchImpl, dir);
  t.after(() => refs.close());
  refs.store.save("saved", mockWav());
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  refs.exclusive(() => gate);
  const detached = refs.forget("saved", refs.store.read().voices.saved.sha256);
  const restore = refs.prepare(provider);
  release();
  await detached;
  await restore;
  assert.equal(remote.uploads.length, 0);
  assert.deepEqual(refs.store.read().voices, {});
});

test("restoration progress counts checked, uploaded and failed voices and is scoped to its provider", async (t) => {
  const dir = temp(t),
    remote = server("speech");
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const refs = new ReferenceVoices(async (url, init) => {
    if (init?.method === "POST") {
      started();
      await gate;
    }
    return remote.fetchImpl(url, init);
  }, dir);
  t.after(() => refs.close());
  refs.store.save("external", mockWav());
  refs.store.bind("external", provider);
  refs.store.save("new", mockWav());
  refs.store.save("missing", mockWav());
  unlinkSync(join(dir, "voices/missing.wav"));
  const restoring = refs.prepare(provider);
  await waiting;
  assert.deepEqual(refs.progress(provider), {
    state: "running",
    completed: 1,
    total: 3,
    failed: 0,
  });
  assert.equal(
    refs.progress({ ...provider, baseUrl: "http://localhost:9999" }),
    null,
  );
  const snapshot = refs.progress(provider);
  snapshot.completed = 999;
  assert.equal(refs.progress(provider).completed, 1);
  release();
  await restoring;
  assert.deepEqual(refs.progress(provider), {
    state: "completed",
    completed: 3,
    total: 3,
    failed: 1,
  });
});

test("cancelled restoration never leaves running progress and Irodori does not report startup restoration", async (t) => {
  const dir = temp(t),
    remote = server("speech"),
    controller = new AbortController();
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const refs = new ReferenceVoices(async (url, init) => {
    if (init?.method !== "POST") return remote.fetchImpl(url, init);
    started();
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true,
      }),
    );
  }, dir);
  t.after(() => refs.close());
  refs.store.save("new", mockWav());
  const restoring = refs.prepare(provider, controller.signal);
  const rejected = assert.rejects(restoring, /cancelled/);
  await waiting;
  controller.abort(new Error("cancelled"));
  await rejected;
  assert.equal(refs.progress(provider).state, "failed");
  const irodori = server("irodori"),
    p = { ...provider, type: "irodori" };
  refs.fetch = irodori.fetchImpl;
  await refs.prepare(p);
  assert.equal(refs.progress(p), null);
});
