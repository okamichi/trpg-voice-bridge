import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  loadOpus,
  encodeOggOpus,
  downsampleWav,
  wavToPcm16,
} from "./audio-format.mjs";
import { mockWav, inspectWav } from "./provider.mjs";

function oggPackets(ogg) {
  const packets = [];
  let partial = [],
    granule = 0n;
  for (let at = 0; at < ogg.length;) {
    assert.equal(ogg.toString("ascii", at, at + 4), "OggS");
    granule = ogg.readBigInt64LE(at + 6);
    const count = ogg[at + 26];
    let offset = at + 27 + count;
    for (let i = 0; i < count; i++) {
      const size = ogg[at + 27 + i];
      partial.push(ogg.subarray(offset, offset + size));
      offset += size;
      if (size < 255) {
        packets.push(Buffer.concat(partial));
        partial = [];
      }
    }
    at = offset;
  }
  return { packets, granule };
}

test("Bridge and the Discord runtime pin the same opusscript", () => {
  // npm start encodes Opus without the Discord dependencies; a package uses
  // the Discord runtime's copy. Both must be the same release.
  const pin = (path) =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))
      .dependencies.opusscript;
  assert.equal(pin("../package.json"), pin("../discord/package.json"));
});

test("Opus output is a valid Ogg stream that decodes back to the speech", async (t) => {
  const Opus = await loadOpus();
  if (!Opus) return t.skip("opusscript is not installed (npm ci)");
  const wav = mockWav(1);
  const ogg = encodeOggOpus(wav, Opus, 64000);
  assert.ok(ogg.length < wav.length / 4);
  const { packets, granule } = oggPackets(ogg);
  assert.equal(packets[0].toString("ascii", 0, 8), "OpusHead");
  assert.equal(packets[1].toString("ascii", 0, 8), "OpusTags");
  // Granule counts 48kHz samples including the 312-sample pre-skip.
  assert.equal(granule, 312n + 48000n);
  const decoder = new Opus(24000, 1);
  try {
    const pcm = Buffer.concat(packets.slice(2).map((p) => decoder.decode(p)));
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // mockWav is a 440Hz tone with a peak of 1500.
    assert.ok(peak > 1000 && peak < 2500, `peak ${peak}`);
  } finally {
    decoder.delete();
  }
  for (const bitrate of [32000, 96000]) {
    const size = encodeOggOpus(wav, Opus, bitrate).length;
    assert.ok(
      Math.abs(size - bitrate / 8) < bitrate / 16,
      `${bitrate}: ${size}`,
    );
  }
});

test("WAV 256k is 16kHz mono 16-bit; sources at or below 16kHz stay as they are", () => {
  const wav = mockWav(1);
  const small = downsampleWav(wav, 16000);
  assert.equal(inspectWav(small).sampleRateHz, 16000);
  assert.ok(Math.abs(inspectWav(small).durationMs - 1000) < 1);
  assert.equal(small.length, 44 + 16000 * 2);
  assert.equal(downsampleWav(small, 16000), null);
  const { pcm, rate } = wavToPcm16(wav);
  assert.equal(rate, 24000);
  assert.equal(pcm.length, 24000);
});
