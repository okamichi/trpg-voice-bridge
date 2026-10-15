// Decode RIFF PCM/IEEE float without FFmpeg. Output is always 48kHz stereo s16le.
export function toDiscordPcm(wav) {
  if (
    !Buffer.isBuffer(wav) ||
    wav.length < 12 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("RIFF WAVが必要です");
  const end = wav.readUInt32LE(4) + 8;
  if (end > wav.length || end < 12) throw new Error("WAVが途切れています");
  let fmt, data;
  for (let offset = 12; offset + 8 <= end;) {
    const size = wav.readUInt32LE(offset + 4),
      start = offset + 8;
    if (start + size > end) throw new Error("WAVチャンクが途切れています");
    const id = wav.toString("ascii", offset, offset + 4);
    if (id === "fmt ") fmt = wav.subarray(start, start + size);
    if (id === "data") data = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!fmt || fmt.length < 16 || !data)
    throw new Error("WAVのfmt/dataがありません");
  const format = fmt.readUInt16LE(0),
    channels = fmt.readUInt16LE(2),
    rate = fmt.readUInt32LE(4),
    align = fmt.readUInt16LE(12),
    bits = fmt.readUInt16LE(14);
  if (
    ![1, 2].includes(channels) ||
    rate < 8000 ||
    rate > 192000 ||
    !(
      (format === 1 && [16, 24, 32].includes(bits)) ||
      (format === 3 && [32, 64].includes(bits))
    ) ||
    align !== (channels * bits) / 8 ||
    data.length % align
  )
    throw new Error("未対応または不正なWAV形式です");
  const frames = data.length / align,
    count = Math.round((frames * 48000) / rate);
  const out = Buffer.alloc(count * 4);
  const sample = (frame, channel) => {
    const offset = frame * align + (Math.min(channel, channels - 1) * bits) / 8;
    const value =
      format === 3
        ? bits === 32
          ? data.readFloatLE(offset)
          : data.readDoubleLE(offset)
        : data.readIntLE(offset, bits / 8) / 2 ** (bits - 1);
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  };
  for (let i = 0; i < count; i++) {
    const position = Math.min((i * rate) / 48000, frames - 1),
      lo = Math.floor(position),
      hi = Math.min(lo + 1, frames - 1),
      fraction = position - lo;
    for (let channel = 0; channel < 2; channel++) {
      const value =
        sample(lo, channel) * (1 - fraction) + sample(hi, channel) * fraction;
      out.writeInt16LE(
        Math.max(-32768, Math.min(32767, Math.round(value * 32768))),
        i * 4 + channel * 2,
      );
    }
  }
  return out;
}
