import test from "node:test";
import assert from "node:assert/strict";
import {
  voiceConstraints,
  currentVoiceConstraints,
} from "./voice-constraints.mjs";
import { payload } from "./provider.mjs";
const model = {
  id: "renamed-model",
  speech: {
    architecture: "irodori-tts",
    task: "synthesis",
    voices: [{ name: "none" }],
    options: [{ name: "steps", default: 4 }, { name: "instructions" }],
  },
};
const voice = {
  id: "voice",
  name: "声",
  provider: "irodori-local",
  voiceId: "none",
  caption: "穏やか",
  seed: "1",
  speed: 1,
  steps: 20,
  cfgScaleText: 3,
  cfgScaleCaption: 3,
  cfgScaleSpeaker: 5,
};
test("MF uses metadata, forces four steps and omits all CFG without modifying stored voice", () => {
  assert.equal(voiceConstraints(model).fixedSteps, 4);
  const body = JSON.parse(
    payload("こんにちは", voice, { type: "speech" }, "append", model),
  );
  assert.equal(body.steps, 4);
  assert.equal(
    Object.keys(body).some((k) => k.startsWith("cfg_")),
    false,
  );
  assert.equal(voice.steps, 20);
  assert.equal(voice.cfgScaleText, 3);
});
test("missing metadata, other architectures and RF are not MF", () => {
  for (const speech of [
    undefined,
    { ...model.speech, architecture: "qwen3-tts" },
    { ...model.speech, options: [{ name: "steps", default: 40 }] },
    {
      ...model.speech,
      options: [...model.speech.options, { name: "cfg_scale_text" }],
    },
  ]) {
    assert.equal(voiceConstraints({ speech }).fixedSteps, null);
  }
});
test("constraints use the currently served model and propagate unavailable TTS", async () => {
  assert.equal(
    (
      await currentVoiceConstraints(
        { type: "speech", baseUrl: "http://tts" },
        async () => Response.json({ data: [model] }),
      )
    ).fixedSteps,
    4,
  );
  await assert.rejects(
    currentVoiceConstraints(
      { type: "speech", baseUrl: "http://tts" },
      async () => Response.json({}, { status: 503 }),
    ),
  );
  assert.equal(
    (await currentVoiceConstraints({ type: "mock" })).fixedSteps,
    null,
  );
});
