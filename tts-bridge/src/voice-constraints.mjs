import { speechModel } from "./tts-api.mjs";

// The pinned speech.cpp exposes GGUF architecture and inference options, even
// when the file has been renamed. Never infer MeanFlow from its filename alone.
export function voiceConstraints(model) {
  const speech = model?.speech;
  const options = speech?.options;
  const meanFlow =
    speech?.architecture === "irodori-tts" &&
    speech.task === "synthesis" &&
    Array.isArray(options) &&
    options.some((o) => o.name === "steps" && o.default === 4) &&
    !options.some((o) => o.name.startsWith("cfg_"));
  return { status: "ready", fixedSteps: meanFlow ? 4 : null, cfg: !meanFlow };
}

export async function currentVoiceConstraints(provider, fetchImpl = fetch) {
  if (provider.type !== "speech") return voiceConstraints();
  return voiceConstraints(await speechModel(provider, fetchImpl));
}
