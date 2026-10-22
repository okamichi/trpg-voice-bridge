import { inspectWav } from "./provider.mjs";
export { AUDIO_FORMATS, DEFAULT_AUDIO_FORMAT } from "./contracts.mjs";

const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];
const OPUS_SET_BITRATE = 4002;
// libopus reports 312 samples of encoder delay at 48kHz for these settings.
const PRE_SKIP = 312;

let loaded;
/**
 * The Discord runtime already ships opusscript (libopus in WebAssembly).
 * Without it, audio is delivered as WAV.
 */
export async function loadOpus() {
  loaded ??= import("../discord/dependencies.mjs")
    .then(({ discordRequire }) => discordRequire("opusscript"))
    .catch(() => null);
  return loaded;
}

/**
 * Mono 16-bit samples from any WAV inspectWav allows, at `toRate`, or at a
 * rate Opus accepts when no rate is given.
 */
export function wavToPcm16(wav, toRate) {
  inspectWav(wav);
  let fmt,
    data = [];
  for (let offset = 12; offset + 8 <= wav.length;) {
    const tag = wav.toString("ascii", offset, offset + 4),
      n = wav.readUInt32LE(offset + 4),
      start = offset + 8;
    if (tag === "fmt ")
      fmt = {
        format: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        rate: wav.readUInt32LE(start + 4),
        bits: wav.readUInt16LE(start + 14),
      };
    if (tag === "data") data.push(wav.subarray(start, start + n));
    offset = start + n + (n % 2);
  }
  const bytes = Buffer.concat(data),
    width = fmt.bits / 8,
    frames = bytes.length / (width * fmt.channels);
  const sample = (i) => {
    const at = i * width;
    if (fmt.format === 3) return bytes.readFloatLE(at);
    if (fmt.bits === 16) return bytes.readInt16LE(at) / 32768;
    if (fmt.bits === 24) return bytes.readIntLE(at, 3) / 8388608;
    return bytes.readInt32LE(at) / 2147483648;
  };
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += sample(f * fmt.channels + c);
    mono[f] = sum / fmt.channels;
  }
  // Rates Opus cannot take are resampled to 48kHz.
  const rate = toRate ?? (OPUS_RATES.includes(fmt.rate) ? fmt.rate : 48000),
    step = fmt.rate / rate,
    count = Math.round(frames / step),
    pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    let value;
    if (step > 1) {
      // Averaging over each output sample keeps downsampling from aliasing badly.
      const from = Math.floor(i * step),
        to = Math.min(frames, Math.max(from + 1, Math.floor((i + 1) * step)));
      value = 0;
      for (let j = from; j < to; j++) value += mono[j];
      value /= to - from;
    } else {
      const at = i * step,
        low = Math.min(Math.floor(at), frames - 1),
        high = Math.min(low + 1, frames - 1);
      value = mono[low] + (mono[high] - mono[low]) * (at - low);
    }
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
  }
  return { pcm, rate, sourceRate: fmt.rate };
}

const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let j = 0; j < 8; j++)
    r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  CRC[i] = r >>> 0;
}
function crc32(buffer) {
  let crc = 0;
  for (const byte of buffer)
    crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}
function oggPage(packets, { granule, serial, sequence, first, last }) {
  const lacing = [];
  for (const p of packets) {
    for (let n = p.length; n >= 255; n -= 255) lacing.push(255);
    lacing.push(p.length % 255);
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0, "ascii");
  header[5] = (first ? 2 : 0) | (last ? 4 : 0);
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = lacing.length;
  Buffer.from(lacing).copy(header, 27);
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(crc32(page), 22);
  return page;
}

/** Encodes a WAV as Ogg Opus (RFC 7845), mono, 20ms frames. */
export function encodeOggOpus(wav, Opus, bitrate) {
  const { pcm, rate } = wavToPcm16(wav);
  const frame = rate / 50,
    scale = 48000 / rate,
    encoder = new Opus(rate, 1, Opus.Application.AUDIO);
  const serial = (Math.random() * 0x100000000) >>> 0;
  let sequence = 0;
  try {
    encoder.encoderCTL(OPUS_SET_BITRATE, bitrate);
    const head = Buffer.alloc(19);
    head.write("OpusHead", 0, "ascii");
    head[8] = 1;
    head[9] = 1;
    head.writeUInt16LE(PRE_SKIP, 10);
    head.writeUInt32LE(rate, 12);
    const vendor = Buffer.from("trpg-voice-bridge"),
      tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write("OpusTags", 0, "ascii");
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    const pages = [
      oggPage([head], {
        granule: 0,
        serial,
        sequence: sequence++,
        first: true,
      }),
      oggPage([tags], { granule: 0, serial, sequence: sequence++ }),
    ];
    const frames = Math.max(
        1,
        Math.ceil((pcm.length + PRE_SKIP / scale) / frame),
      ),
      end = PRE_SKIP + Math.round(pcm.length * scale);
    let pending = [];
    for (let f = 0; f < frames; f++) {
      const chunk = new Int16Array(frame);
      chunk.set(pcm.subarray(f * frame, (f + 1) * frame));
      // opusscript copies the input byte for byte.
      pending.push(encoder.encode(Buffer.from(chunk.buffer), frame));
      const last = f === frames - 1;
      if (pending.length === 50 || last) {
        pages.push(
          oggPage(pending, {
            granule: last ? end : Math.round((f + 1) * frame * scale),
            serial,
            sequence: sequence++,
            last,
          }),
        );
        pending = [];
      }
    }
    return Buffer.concat(pages);
  } finally {
    encoder.delete();
  }
}

/** A mono 16-bit WAV at `rate`, or null when the source is not above it. */
export function downsampleWav(wav, rate) {
  const header = wavToPcm16(wav, rate);
  if (header.sourceRate <= rate) return null;
  const { pcm } = header,
    b = Buffer.alloc(44 + pcm.length * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer).copy(b, 44);
  return b;
}
