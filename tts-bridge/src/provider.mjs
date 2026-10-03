import { readLimited } from "../synthesis.mjs";
import { parseDelivery } from "../delivery.mjs";
import { check, voiceSchema } from "./contracts.mjs";
export const AUDIO_LIMIT = 25 * 1024 * 1024;
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
export function payload(text, v, p) {
  voiceSchema(v);
  const delivery = parseDelivery(text);
  const caption = [
    v.caption,
    delivery.caption ? `この発言の演技指示: ${delivery.caption}。` : "",
  ]
    .filter(Boolean)
    .join("。");
  check(caption.length <= 1000, "演技指示込みのcaptionは1000文字までです");
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
  { fetchImpl = fetch, timeoutMs = 120000 } = {},
) {
  if (provider.type === "mock") return mockWav();
  const response = await fetchImpl(`${provider.baseUrl}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload(text, voice, provider),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`TTS HTTP ${response.status}`);
  }
  return readLimited(response, AUDIO_LIMIT);
}
