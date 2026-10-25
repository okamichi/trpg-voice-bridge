import { parseDelivery } from "../delivery.mjs";
import { check, voiceSchema, DELIVERY_CAPTION_MODES } from "./contracts.mjs";
import { speechModel } from "./tts-api.mjs";
export const AUDIO_LIMIT = 25 * 1024 * 1024;
export async function readLimited(response, limit) {
  if (!response.body || Number(response.headers.get("content-length")) > limit)
    throw new Error("応答が大きすぎます");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("応答が大きすぎます");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel();
    throw error;
  }
}
export function inspectWav(b) {
  check(
    b.length >= 44 &&
      b.length <= AUDIO_LIMIT &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WAVE" &&
      b.readUInt32LE(4) + 8 === b.length,
    "不正なWAV",
    502,
  );
  let fmt,
    data = 0,
    offset = 12;
  while (offset + 8 <= b.length) {
    const tag = b.toString("ascii", offset, offset + 4),
      n = b.readUInt32LE(offset + 4),
      start = offset + 8;
    check(start + n <= b.length, "WAVが破損しています", 502);
    if (tag === "fmt ") {
      check(n >= 16, "WAV fmtが不正です", 502);
      fmt = {
        format: b.readUInt16LE(start),
        channels: b.readUInt16LE(start + 2),
        sampleRateHz: b.readUInt32LE(start + 4),
        rate: b.readUInt32LE(start + 8),
        align: b.readUInt16LE(start + 12),
        bits: b.readUInt16LE(start + 14),
      };
    }
    if (tag === "data") data += n;
    offset = start + n + (n % 2);
  }
  check(
    fmt &&
      [1, 3].includes(fmt.format) &&
      [1, 2].includes(fmt.channels) &&
      [16, 24, 32].includes(fmt.bits) &&
      fmt.sampleRateHz >= 8000 &&
      fmt.sampleRateHz <= 96000 &&
      fmt.align === (fmt.channels * fmt.bits) / 8 &&
      fmt.rate === fmt.sampleRateHz * fmt.align &&
      data > 0 &&
      data % fmt.align === 0 &&
      offset === b.length,
    "非対応のWAV形式",
    502,
  );
  const durationMs = (data / fmt.rate) * 1000;
  check(durationMs <= 120000, "音声は120秒以下です", 502);
  return {
    durationMs,
    sampleRateHz: fmt.sampleRateHz,
    channels: fmt.channels,
    mediaType: "audio/wav",
  };
}
export function payload(text, v, p, deliveryCaptionMode = "append", model) {
  voiceSchema(v);
  check(
    DELIVERY_CAPTION_MODES.includes(deliveryCaptionMode),
    "感情・演技の指定方法が不正です",
  );
  const delivery = parseDelivery(text);
  const instruction = delivery.caption
    ? `この発言の演技指示: ${delivery.caption}。`
    : "";
  const hasReference = ![
    "none",
    "no_ref",
    "no-ref",
    "null",
    "text-only",
  ].includes(v.voiceId.toLowerCase());
  const caption =
    instruction && deliveryCaptionMode === "replace" && hasReference
      ? instruction
      : (deliveryCaptionMode === "prepend"
          ? [instruction, v.caption]
          : [v.caption, instruction]
        )
          .filter(Boolean)
          .join("。");
  check(caption.length <= 1000, "演技指示込みのcaptionは1000文字までです");
  if (p.type === "speech") {
    const voiceId = hasReference ? v.voiceId : "none";
    const takes = (name) => model?.speech.options?.some((o) => o.name === name);
    check(
      model?.speech.voices.some((voice) => voice.name === voiceId),
      `参照音声「${v.voiceId}」が現在のTTSにありません`,
      409,
    );
    check(
      !caption || takes("instructions"),
      "このモデルは声の説明・演技指示に対応していません。対応するGGUFを選んでください",
      409,
    );
    const body = {
      model: model.id,
      input: delivery.input,
      voice: voiceId,
      response_format: "pcm",
      speed: v.speed,
      steps: v.steps,
      seed: Number(BigInt(v.seed) % (1n << 53n)),
      ...(takes("instructions") ? { instructions: caption } : {}),
    };
    for (const [key, name, active] of [
      ["cfgScaleText", "cfg_scale_text", true],
      ["cfgScaleCaption", "cfg_scale_instructions", Boolean(caption.trim())],
      ["cfgScaleSpeaker", "cfg_scale_speaker", hasReference],
    ])
      if (active && takes(name) && v[key] != null) body[name] = v[key];
    return JSON.stringify(body);
  }
  const irodori = {
    caption,
    seed: "__SEED__",
    num_steps: v.steps,
    max_seconds: 120,
    chunking_enabled: false,
  };
  for (const [k, a] of [
    ["cfgScaleText", "cfg_scale_text"],
    ["cfgScaleCaption", "cfg_scale_caption"],
    ["cfgScaleSpeaker", "cfg_scale_speaker"],
  ])
    if (v[k] !== undefined && v[k] !== null) irodori[a] = v[k];
  return JSON.stringify({
    model: p.model,
    input: delivery.input,
    voice: v.voiceId,
    response_format: "wav",
    speed: v.speed,
    irodori,
  }).replace('"seed":"__SEED__"', `"seed":${BigInt(v.seed)}`);
}
export function mockWav(seconds = 0.12) {
  const count = Math.round(24000 * seconds),
    b = Buffer.alloc(44 + count * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(count * 2, 40);
  for (let n = 0; n < count; n++)
    b.writeInt16LE(
      Math.round(
        Math.sin((n / 24000) * 440 * Math.PI * 2) *
          1500 *
          Math.min(1, n / 120, (count - n) / 120),
      ),
      44 + n * 2,
    );
  return b;
}
export async function synthesize(
  text,
  voice,
  provider,
  {
    fetchImpl = fetch,
    timeoutMs = 120000,
    signal,
    deliveryCaptionMode = "append",
    model,
  } = {},
) {
  if (provider.type === "mock") return mockWav();
  signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  if (provider.type === "speech") {
    model ??= await speechModel(provider, fetchImpl, signal);
    return synthesizeSpeech(text, voice, provider, {
      fetchImpl,
      signal,
      deliveryCaptionMode,
      model,
    });
  }
  const response = await fetchImpl(`${provider.baseUrl}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload(text, voice, provider, deliveryCaptionMode),
    signal: AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok) {
    let detail;
    try {
      detail = JSON.parse((await readLimited(response, 8192)).toString("utf8"));
    } catch {
      // An HTML proxy error or an oversized body must not hide the HTTP status.
    } finally {
      await response.body?.cancel().catch(() => {});
    }
    const problem = detail?.error;
    if (
      response.status === 400 &&
      problem?.param === "voice" &&
      ["unsupported_value", "voice_not_found"].includes(problem.code) &&
      typeof problem.message === "string" &&
      /no voice named|voice.*not found|unknown voice/i.test(problem.message)
    )
      throw new Error(
        `TTS HTTP 400: 参照音声「${voice.voiceId}」が現在のTTSサーバーに登録されていません。音声フォルダーの指定と登録済み音声を確認してください`,
      );
    const message =
      typeof problem?.message === "string"
        ? problem.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)
        : "";
    throw new Error(
      `TTS HTTP ${response.status}${message ? `: ${message}` : ""}`,
    );
  }
  return readLimited(response, AUDIO_LIMIT);
}

// Native speech.cpp streams mono s16le. Bound the stream before constructing
// the WAV; cancellation also stops work on the server when 120 seconds is met.
async function synthesizeSpeech(text, voice, provider, options) {
  const { fetchImpl, signal, deliveryCaptionMode, model } = options;
  const base = JSON.parse(
    payload(text, voice, provider, deliveryCaptionMode, model),
  );
  let rate,
    bytes = 0,
    attempts = 0;
  const chunks = [];
  const generate = async (input) => {
    signal.throwIfAborted();
    check(++attempts <= 64, "長文の分割上限です。文章を短くしてください", 502);
    const response = await fetchImpl(`${provider.baseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...base, input }),
      signal,
    });
    if (!response.ok) {
      let problem;
      try {
        problem = JSON.parse(
          (await readLimited(response, 8192)).toString("utf8"),
        ).error;
      } catch {
        /* Keep the HTTP status if a proxy did not return JSON. */
      } finally {
        await response.body?.cancel().catch(() => {});
      }
      if (
        response.status === 400 &&
        problem?.param === "input" &&
        problem?.code === "unsupported_value"
      ) {
        const points = [...input];
        check(
          points.length > 1,
          "入力が長すぎます。文章を短くしてください",
          502,
        );
        const middle = Math.floor(points.length / 2);
        await generate(points.slice(0, middle).join(""));
        if (bytes < rate * 2 * 120)
          await generate(points.slice(middle).join(""));
        return;
      }
      if (
        problem?.param === "instructions" &&
        /tokens long|at most/.test(problem.message ?? "")
      )
        throw Error(
          "声の説明・演技指示がモデルの上限を超えています。captionや発言内の演技指示を短くしてください",
        );
      const message =
        typeof problem?.message === "string"
          ? problem.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)
          : "";
      throw Error(
        `TTS HTTP ${response.status}${message ? `: ${message}` : ""}`,
      );
    }
    const sampleRate = Number(response.headers.get("X-Sample-Rate"));
    const reader = response.body?.getReader();
    try {
      check(
        Number.isInteger(sampleRate) &&
          sampleRate >= 8000 &&
          sampleRate <= 96000 &&
          (!rate || sampleRate === rate),
        "TTSのサンプルレートが不正です",
        502,
      );
      rate = sampleRate;
      check(reader, "TTSの音声が空です", 502);
      const limit = Math.min(rate * 2 * 120, AUDIO_LIMIT - 44);
      let received = 0;
      while (bytes < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        const chunk = Buffer.from(value.subarray(0, limit - bytes));
        chunks.push(chunk);
        bytes += chunk.length;
      }
      check(
        bytes === limit || (received > 0 && received % 2 === 0),
        "TTSのPCM音声が不正です",
        502,
      );
    } catch (error) {
      // A mid-stream failure may be a long clause, a network interruption or
      // a stopped server. Never publish the partial PCM or guess the cause.
      signal.throwIfAborted();
      if (error.status) throw error;
      throw new Error(
        "TTSからの音声受信が途中で中断されました。文章を短くするか、TTSの状態と接続を確認して再試行してください",
        { cause: error },
      );
    } finally {
      await reader?.cancel().catch(() => {});
    }
  };
  await generate(base.input);
  const wav = Buffer.alloc(44 + bytes);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(bytes, 40);
  Buffer.concat(chunks, bytes).copy(wav, 44);
  inspectWav(wav);
  return wav;
}
