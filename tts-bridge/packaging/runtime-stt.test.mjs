import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:net";
import {
  setImmediate as tick,
  setTimeout as delay,
} from "node:timers/promises";
import { RuntimeSettings, validateRuntime } from "../src/runtime/settings.mjs";
import { SpeechRuntime } from "../src/runtime/speech.mjs";

const supervisor = resolve(
  ".packaging/native-build",
  ...(process.platform === "win32"
    ? ["Release", "bridge-supervisor.exe"]
    : ["bridge-supervisor"]),
);
const recognition = {
  id: "qwen3-asr-0.6b",
  speech: {
    task: "recognition",
    options: [{ name: "language" }, { name: "prompt" }],
  },
};
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-stt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("STT settings migrate, validate paths and mode, persist and require restart", async (t) => {
  const dir = directory(t);
  const legacy = { mode: "bundled", model: "", ttsPort: 18088 };
  writeFileSync(join(dir, "runtime.json"), JSON.stringify(legacy));
  const runtime = new SpeechRuntime({ dataDir: dir, runtimeDir: dir });
  assert.deepEqual(runtime.settings.active.stt, {
    enabled: false,
    model: "",
    logDir: "",
  });
  assert.deepEqual(runtime.snapshot().stt, {
    enabled: false,
    status: "off",
    error: "",
  });
  const stt = {
    enabled: true,
    model: join(dir, "recognition.GGUF"),
    logDir: join(dir, "not-created"),
  };
  runtime.settings.save({ ...runtime.settings.saved, stt });
  assert.equal(runtime.snapshot().restartRequired, true);
  assert.deepEqual(new RuntimeSettings(dir).active.stt, stt);
  assert.equal(existsSync(stt.logDir), false);
  for (const invalid of [
    { ...stt, enabled: "true" },
    { ...stt, model: "" },
    { ...stt, model: "relative.gguf" },
    { ...stt, model: join(dir, "model.wav") },
    { ...stt, model: join(dir, "bad\0.gguf") },
    { ...stt, logDir: "relative" },
    { ...stt, logDir: join(dir, "bad\0") },
    { ...stt, logDir: 42 },
    true,
    null,
  ])
    assert.throws(
      () => validateRuntime({ ...legacy, stt: invalid }),
      (e) => e.expose === true,
    );
  assert.throws(
    () => validateRuntime({ ...legacy, mode: "external", stt }),
    /内蔵speech/,
  );
  assert.doesNotThrow(() =>
    validateRuntime({
      ...legacy,
      mode: "external",
      stt: { ...stt, enabled: false },
    }),
  );
  await runtime.close();
});

// Separate real info/serve processes exercise the supervisor launch boundary.
const speechFixture = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [root, command, ...args] = process.argv.slice(2);
if (command === 'info') {
  fs.writeFileSync(path.join(root, 'info-args'), JSON.stringify(args));
  const contents = fs.readFileSync(args[0], 'utf8');
  if (contents === 'nonzero') process.exit(1);
  process.stdout.write(contents);
} else {
  fs.writeFileSync(path.join(root, 'serve-args'), JSON.stringify(args));
  if (fs.existsSync(path.join(root, 'exit'))) process.exit(1);
  const port = Number(args[args.indexOf('--port') + 1]);
  require('node:http').createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') return res.end('{}');
    if (fs.existsSync(path.join(root, 'models-http'))) { res.statusCode = 500; return res.end('{}'); }
    if (fs.existsSync(path.join(root, 'models-json'))) return res.end('{');
    if (fs.existsSync(path.join(root, 'models-network'))) return req.destroy();
    const present = args[1] && !args[1].startsWith('--') && !fs.existsSync(path.join(root, 'no-recognition'));
    res.end(JSON.stringify({ data: present ? [{ id: 'asr', speech: { task: 'recognition', options: [] } }] : [] }));
  }).listen(port, '127.0.0.1');
}
`;
async function startup(t, kind) {
  const dir = directory(t);
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const model = join(dir, "tts.gguf"),
    asr = join(dir, "stt.gguf"),
    script = join(dir, "speech.cjs");
  writeFileSync(model, "tts");
  writeFileSync(script, speechFixture);
  if (kind !== "missing")
    writeFileSync(
      asr,
      kind === "malformed"
        ? "{"
        : kind === "nonzero"
          ? "nonzero"
          : JSON.stringify({
              task: kind === "synthesis" ? "synthesis" : "recognition",
            }),
    );
  if (kind === "unreadable") chmodSync(asr, 0);
  if (
    [
      "exit",
      "no-recognition",
      "models-http",
      "models-json",
      "models-network",
    ].includes(kind)
  )
    writeFileSync(join(dir, kind), "");
  const runtime = new SpeechRuntime({
    dataDir: dir,
    runtimeDir: dirname(supervisor),
    startupTimeout: 5000,
    speechProgram: [process.execPath, script, dir],
    overrides: {
      mode: "bundled",
      model,
      ttsPort: port,
      stt: { enabled: kind !== "off", model: asr, logDir: "" },
    },
  });
  const command = runtime.speechCommand.bind(runtime);
  t.mock.method(runtime, "speechCommand", () => {
    const args = command();
    args.splice(2, 1, process.execPath, script, dir);
    return args;
  });
  t.mock.method(runtime.references, "prepare", async () => {});
  return { runtime, dir, asr, command };
}
for (const kind of [
  "recognition",
  "off",
  "missing",
  "unreadable",
  "synthesis",
  "malformed",
  "nonzero",
  "no-recognition",
  "exit",
  "models-http",
  "models-json",
  "models-network",
]) {
  test(
    `STT preflight and real supervisor startup: ${kind}`,
    {
      skip:
        !existsSync(supervisor) ||
        (kind === "unreadable" &&
          (process.platform === "win32" || process.getuid?.() === 0)),
    },
    async (t) => {
      const { runtime, dir, asr, command } = await startup(t, kind);
      const changes = [];
      const unsubscribe = runtime.onSttChange((state) => changes.push(state));
      runtime.onSttChange(() => {
        throw Error("extension failure");
      });
      try {
        assert.ok(!command().includes(asr));
        await runtime.acquire();
        const accepted = [
          "recognition",
          "no-recognition",
          "exit",
          "models-http",
          "models-json",
          "models-network",
        ].includes(kind);
        assert.equal(command().includes(asr), accepted);
        assert.equal(existsSync(join(dir, "serve-args")), false);
        const inspected = !["off", "missing", "unreadable"].includes(kind);
        assert.equal(existsSync(join(dir, "info-args")), inspected);
        if (inspected)
          assert.deepEqual(JSON.parse(readFileSync(join(dir, "info-args"))), [
            asr,
            "--json",
          ]);
        await runtime.start();
        assert.equal(runtime.status, kind === "exit" ? "error" : "ready");
        assert.equal(
          runtime.stt.status,
          kind === "recognition" ? "ready" : kind === "off" ? "off" : "error",
        );
        assert.equal(
          JSON.parse(readFileSync(join(dir, "serve-args"))).includes(asr),
          accepted,
        );
        if (kind === "exit")
          assert.match(runtime.error, /STTを無効にして再起動/);
        if (kind === "synthesis")
          assert.match(runtime.stt.error, /音声認識のモデルではありません/);
        if (["missing", "unreadable"].includes(kind))
          assert.match(runtime.stt.error, /見つからないか読み取れません/);
        if (kind !== "off")
          assert.deepEqual(changes.at(-1), runtime.snapshot().stt);
        if (kind === "recognition") {
          runtime.fail("child stopped");
          assert.equal(changes.at(-1).status, "error");
        }
        unsubscribe();
        const count = changes.length;
        await runtime.close();
        assert.equal(changes.length, count);
      } finally {
        await runtime.close();
        if (kind === "unreadable") chmodSync(asr, 0o600);
      }
    },
  );
}

function readyRuntime(t, handler, backend = "metal") {
  const dir = directory(t),
    calls = [];
  const runtime = new SpeechRuntime({
    dataDir: dir,
    runtimeDir: dir,
    backends: ["metal", "cpu"],
    overrides: {
      mode: "bundled",
      backend,
      stt: { enabled: true, model: join(dir, "model.gguf"), logDir: "" },
    },
    fetchImpl: async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      calls.push({ path, init });
      return handler(path, init);
    },
  });
  runtime.status = "ready";
  runtime.recognition = structuredClone(recognition);
  runtime.setStt("ready");
  return { runtime, calls };
}
const wav = Buffer.from("RIFF\0\0\0\0WAVEdata");
const speak = (runtime, signal) =>
  runtime.fetch("http://127.0.0.1:18088/v1/audio/speech", {
    method: "POST",
    signal,
  });

test("transcribe sends the supplied WAV and only supported options, returning trimmed text", async (t) => {
  const { runtime, calls } = readyRuntime(t, () =>
    Response.json({ text: " こんにちは " }),
  );
  for (const language of [true, false]) {
    if (!language) runtime.recognition.speech.options = [];
    assert.equal(await runtime.transcribe(wav), "こんにちは");
    const { init } = calls.at(-1);
    assert.equal(init.method, "POST");
    assert.equal(init.body.get("model"), recognition.id);
    assert.equal(init.body.get("response_format"), "json");
    assert.equal(init.body.get("language"), language ? "ja" : null);
    assert.equal(init.body.get("prompt"), null);
    assert.equal(init.body.get("chunking_strategy"), null);
    const file = init.body.get("file");
    assert.equal(file.type, "audio/wav");
    assert.equal(file.name, "utterance.wav");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav);
  }
  runtime.setStt("error", "not ready");
  await assert.rejects(runtime.transcribe(wav), /not ready/);
  assert.equal(calls.length, 2);
  await runtime.close();
});

for (const outcome of [
  "end",
  "cancel",
  "abort",
  "body-error",
  "fetch-error",
  "http-error",
]) {
  test(`TTS priority lasts through response body; STT resumes on ${outcome}`, async (t) => {
    const gate = Promise.withResolvers();
    let controller;
    const source = new ReadableStream({
      start(c) {
        controller = c;
      },
    });
    const { runtime, calls } = readyRuntime(t, async (path) => {
      if (path.endsWith("transcriptions")) return Response.json({ text: "ok" });
      await gate.promise;
      if (outcome === "fetch-error") throw Error("network failed");
      return new Response(source, {
        status: outcome === "http-error" ? 500 : 200,
      });
    });
    const abort = new AbortController();
    const responsePromise = speak(runtime, abort.signal);
    const rejection =
      outcome === "fetch-error"
        ? assert.rejects(responsePromise, /network failed/)
        : null;
    const transcription = runtime.transcribe(wav);
    await tick();
    assert.equal(calls.length, 1);
    gate.resolve();
    if (rejection) await rejection;
    else {
      const response = await responsePromise;
      await tick();
      assert.equal(calls.length, 1, "headers must not release priority");
      if (outcome === "cancel" || outcome === "http-error")
        await response.body.cancel();
      else if (outcome === "abort") {
        abort.abort();
        await assert.rejects(response.text(), { name: "AbortError" });
      } else {
        const text = response.text();
        if (outcome === "body-error") {
          controller.error(Error("body failed"));
          await assert.rejects(text, /body failed/);
        } else {
          controller.enqueue(new TextEncoder().encode("pcm"));
          await tick();
          assert.equal(calls.length, 1);
          controller.close();
          assert.equal(await text, "pcm");
        }
      }
    }
    assert.equal(await transcription, "ok");
    assert.equal(runtime.ttsActive, 0);
    assert.equal(runtime.activityListeners.size, 0);
    await runtime.close();
  });
}

test("STT waits for all overlapping TTS bodies, including a later Request", async (t) => {
  const { runtime, calls } = readyRuntime(t, (path) =>
    path.endsWith("speech")
      ? new Response("pcm")
      : Response.json({ text: "ok" }),
  );
  const first = await speak(runtime);
  const transcription = runtime.transcribe(wav);
  const second = await runtime.fetch(
    new Request("http://localhost/v1/audio/speech", { method: "POST" }),
  );
  await first.text();
  await tick();
  assert.equal(calls.length, 2);
  await second.text();
  assert.equal(await transcription, "ok");
  await runtime.close();
});

for (const backend of ["cpu", "metal"]) {
  test(`${backend}: serial STT and priority for arriving TTS`, async (t) => {
    const gate = Promise.withResolvers();
    let first = true;
    const { runtime, calls } = readyRuntime(
      t,
      async (path) => {
        if (path.endsWith("speech")) return new Response("pcm");
        if (first) {
          first = false;
          await gate.promise;
        }
        return Response.json({ text: "ok" });
      },
      backend,
    );
    const one = runtime.transcribe(wav),
      two = runtime.transcribe(wav),
      three = runtime.transcribe(wav);
    const tts = speak(runtime);
    await tick();
    assert.deepEqual(
      calls.map((c) => c.path),
      backend === "cpu"
        ? ["/v1/audio/transcriptions"]
        : ["/v1/audio/transcriptions", "/v1/audio/speech"],
    );
    gate.resolve();
    assert.equal(await one, "ok");
    const response = await tts;
    await tick();
    assert.equal(
      calls.length,
      2,
      "queued TTS takes priority over the next STT",
    );
    await response.text();
    assert.deepEqual(await Promise.all([two, three]), ["ok", "ok"]);
    await runtime.close();
  });
}

test("abort STT during priority wait removes its waiter without sending", async (t) => {
  const { runtime, calls } = readyRuntime(t, () => new Response("pcm"));
  const response = await speak(runtime);
  const abort = new AbortController();
  const transcription = runtime.transcribe(wav, { signal: abort.signal });
  abort.abort();
  await assert.rejects(transcription, { name: "AbortError" });
  assert.equal(runtime.activityListeners.size, 0);
  assert.equal(calls.length, 1);
  await response.body.cancel();
  await assert.rejects(runtime.transcribe(wav, { signal: abort.signal }), {
    name: "AbortError",
  });
  assert.equal(calls.length, 1);
  await runtime.close();
});

for (const outcome of ["abort", "failure", "close"]) {
  test(`CPU TTS released after in-flight STT ${outcome}`, async (t) => {
    const gate = Promise.withResolvers();
    const { runtime, calls } = readyRuntime(
      t,
      (path, { signal }) => {
        if (path.endsWith("speech")) return new Response("pcm");
        signal.addEventListener("abort", () => gate.reject(signal.reason), {
          once: true,
        });
        return gate.promise;
      },
      "cpu",
    );
    const abort = new AbortController();
    const transcription = runtime.transcribe(wav, { signal: abort.signal });
    const rejected = assert.rejects(
      transcription,
      outcome === "failure"
        ? /音声認識 HTTP 400: bad request/
        : { name: "AbortError" },
    );
    const tts = speak(runtime);
    const ttsRejected =
      outcome === "close" ? assert.rejects(tts, { name: "AbortError" }) : null;
    assert.equal(calls.length, 1);
    if (outcome === "abort") abort.abort();
    else if (outcome === "close") await runtime.close();
    else
      gate.resolve(
        Response.json({ error: { message: "bad\nrequest" } }, { status: 400 }),
      );
    await rejected;
    if (ttsRejected) await ttsRejected;
    else assert.equal(await (await tts).text(), "pcm");
    assert.equal(runtime.sttActive, false);
    assert.equal(runtime.ttsActive, 0);
    assert.equal(runtime.activityListeners.size, 0);
    if (outcome !== "close") assert.equal(runtime.stt.status, "ready");
    await runtime.close();
  });
}

test("CPU TTS waiting for STT is itself abortable via Request signal", async (t) => {
  const gate = Promise.withResolvers();
  const { runtime, calls } = readyRuntime(t, () => gate.promise, "cpu");
  const transcription = runtime.transcribe(wav);
  const abort = new AbortController();
  const tts = runtime.fetch(
    new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      signal: abort.signal,
    }),
  );
  abort.abort();
  await assert.rejects(tts, { name: "AbortError" });
  assert.equal(calls.length, 1);
  assert.equal(runtime.ttsActive, 0);
  gate.resolve(Response.json({ text: "ok" }));
  await transcription;
  await runtime.close();
});

for (const phase of ["headers", "body"]) {
  test(`STT HTTP timeout covers stalled ${phase}, starts after priority wait, releases CPU TTS`, async (t) => {
    let requestSignal;
    const { runtime, calls } = readyRuntime(
      t,
      (path, { signal }) => {
        if (path.endsWith("speech")) return new Response("pcm");
        requestSignal = signal;
        if (phase === "headers")
          return new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener(
                "abort",
                () => controller.error(signal.reason),
                { once: true },
              );
            },
          }),
        );
      },
      "cpu",
    );
    assert.equal(runtime.transcriptionTimeout, 120000);
    runtime.transcriptionTimeout = 30;
    const first = await speak(runtime);
    let settled = false;
    const timedOut = assert
      .rejects(runtime.transcribe(wav), { name: "TimeoutError" })
      .then(() => {
        settled = true;
      });
    await delay(70);
    assert.equal(settled, false, "TTS-priority waiting has no HTTP timeout");
    assert.equal(calls.length, 1);
    await first.text();
    await tick();
    const tts = speak(runtime);
    assert.equal(calls.length, 2, "CPU TTS waits for the current STT");
    await delay(70);
    await timedOut;
    assert.equal(requestSignal.aborted, true);
    assert.equal(await (await tts).text(), "pcm");
    assert.equal(runtime.sttActive, false);
    assert.equal(runtime.ttsActive, 0);
    assert.equal(runtime.stt.status, "ready");
    await runtime.close();
  });
}

test("an unread TTS body failure releases STT without waiting for a read", async (t) => {
  let controller;
  const { runtime } = readyRuntime(t, (path) =>
    path.endsWith("speech")
      ? new Response(
          new ReadableStream({
            start(c) {
              controller = c;
            },
          }),
        )
      : Response.json({ text: "ok" }),
  );
  const response = await speak(runtime);
  const transcription = runtime.transcribe(wav);
  controller.error(Error("stream failed"));
  assert.equal(await transcription, "ok");
  await assert.rejects(response.text(), /stream failed/);
  await runtime.close();
});
