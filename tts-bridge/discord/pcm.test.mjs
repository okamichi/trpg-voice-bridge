import test from "node:test";
import assert from "node:assert/strict";
import { toDiscordPcm } from "./pcm.mjs";

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
