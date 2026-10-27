import test from "node:test";
import assert from "node:assert/strict";
import { toDiscordPcm, toMono, wavFile, seconds } from "./pcm.mjs";

function wav({
  rate = 48000,
  channels = 1,
  bits = 16,
  format = 1,
  samples = [0, 0.5, -1],
} = {}) {
  const bytes = bits / 8,
    data = Buffer.alloc(samples.length * bytes);
  samples.forEach((value, i) => {
    if (format === 3)
      data[bits === 32 ? "writeFloatLE" : "writeDoubleLE"](value, i * bytes);
    else
      data.writeIntLE(
        Math.min(2 ** (bits - 1) - 1, Math.round(value * 2 ** (bits - 1))),
        i * bytes,
        bytes,
      );
  });
  // An odd-sized unknown chunk exercises RIFF padding.
  const b = Buffer.alloc(54 + data.length + (data.length % 2));
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVE", 8);
  b.write("JUNK", 12);
  b.writeUInt32LE(1, 16);
  b.write("fmt ", 22);
  b.writeUInt32LE(16, 26);
  b.writeUInt16LE(format, 30);
  b.writeUInt16LE(channels, 32);
  b.writeUInt32LE(rate, 34);
  b.writeUInt32LE(rate * channels * bytes, 38);
  b.writeUInt16LE(channels * bytes, 42);
  b.writeUInt16LE(bits, 44);
  b.write("data", 46);
  b.writeUInt32LE(data.length, 50);
  data.copy(b, 54);
  return b;
}
const values = (b) =>
  Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
test("48kHz mono duplicates channels exactly, preserving signed samples", () => {
  assert.deepEqual(
    values(toDiscordPcm(wav())),
    [0, 0, 16384, 16384, -32768, -32768],
  );
});
test("24kHz stereo resamples each channel independently", () => {
  assert.deepEqual(
    values(
      toDiscordPcm(
        wav({ rate: 24000, channels: 2, samples: [0, -0.5, 0.5, 0] }),
      ),
    ),
    [0, -16384, 8192, -8192, 16384, 0, 16384, 0],
  );
});
for (const bits of [16, 24, 32])
  test(`${bits}-bit PCM conversion`, () => {
    assert.deepEqual(
      values(toDiscordPcm(wav({ bits }))),
      [0, 0, 16384, 16384, -32768, -32768],
    );
  });
for (const bits of [32, 64])
  test(`float${bits} clips and silences non-finite values`, () => {
    assert.deepEqual(
      values(
        toDiscordPcm(
          wav({ format: 3, bits, samples: [2, -2, NaN, Infinity, 0.5] }),
        ),
      ),
      [32767, 32767, -32768, -32768, 0, 0, 0, 0, 16384, 16384],
    );
  });
test("rejects corrupt, truncated and unsupported input", () => {
  for (const b of [
    Buffer.alloc(0),
    wav().subarray(0, 55),
    wav({ channels: 3 }),
    wav({ rate: 0 }),
  ])
    assert.throws(() => toDiscordPcm(b));
});
test("empty data yields empty PCM", () =>
  assert.equal(toDiscordPcm(wav({ samples: [] })).length, 0));

const stereo = (...pairs) => {
  const b = Buffer.alloc(pairs.length * 4);
  pairs.forEach(([l, r], i) => {
    b.writeInt16LE(l, i * 4);
    b.writeInt16LE(r, i * 4 + 2);
  });
  return b;
};

test("seconds counts 48kHz stereo frames", () => {
  assert.equal(seconds(Buffer.alloc(48000 * 4)), 1);
  assert.equal(seconds(Buffer.alloc(960 * 4)), 0.02);
});

test("toMono averages the two channels", () => {
  const mono = toMono(stereo([100, 300], [-32768, -32768], [32767, -32768]));
  assert.deepEqual(
    [0, 1, 2].map((i) => mono.readInt16LE(i * 2)),
    [200, -32768, -1],
  );
});

test("wavFile writes a 16-bit PCM header", () => {
  const wav = wavFile(Buffer.alloc(8), 48000);
  assert.equal(wav.length, 52);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 44);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.equal(wav.readUInt32LE(28), 96000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 8);
});
