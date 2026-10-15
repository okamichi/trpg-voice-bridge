import test from "node:test";
import assert from "node:assert/strict";
import { synthesize, mockWav } from "./provider.mjs";
const voice = {
  id: "melissa",
  provider: "irodori-local",
  name: "メリッサ",
  voiceId: "voice-20261013-2253",
  caption: "明るい声",
  speed: 1,
  seed: "1",
  steps: 20,
};
const provider = {
  type: "irodori",
  baseUrl: "http://tts.invalid",
  model: "irodori-tts",
};

test("missing reference voice reports the configured ID and does not substitute another voice", async () => {
  const calls = [];
  await assert.rejects(
    synthesize("こんにちは", voice, provider, {
      fetchImpl: async (_url, request) => {
        calls.push(JSON.parse(request.body));
        return Response.json(
          {
            error: {
              message:
                'Irodori-TTS-v4-Large has no voice named "voice-20261013-2253"; its voices are none',
              param: "voice",
              code: "unsupported_value",
            },
          },
          { status: 400 },
        );
      },
    }),
    /参照音声「voice-20261013-2253」が現在のTTSサーバーに登録されていません/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].voice, voice.voiceId);
});
test("structured TTS errors include a bounded single-line explanation; invalid bodies retain status", async () => {
  for (const [body, expected] of [
    [
      JSON.stringify({
        error: { message: "invalid\ncaption", param: "caption" },
      }),
      /TTS HTTP 400: invalid caption/,
    ],
    ["<html>proxy failure</html>", /^TTS HTTP 400$/],
    ["x".repeat(9000), /^TTS HTTP 400$/],
  ]) {
    await assert.rejects(
      synthesize("こんにちは", voice, provider, {
        fetchImpl: async () => new Response(body, { status: 400 }),
      }),
      { message: expected },
    );
  }
});
test("successful WAV responses remain unchanged", async () => {
  const wav = mockWav();
  assert.deepEqual(
    await synthesize("こんにちは", voice, provider, {
      fetchImpl: async () => new Response(wav),
    }),
    wav,
  );
});
