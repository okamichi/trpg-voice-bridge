import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { synthesize, inspectWav } from "../src/provider.mjs";
import { initialConfig } from "../src/store.mjs";
const config = initialConfig(
  JSON.parse(readFileSync(new URL("../profiles.json", import.meta.url))),
);
const out = new URL("../verification/", import.meta.url);
mkdirSync(out, { recursive: true });
const healthBefore = await (
  await fetch(config.provider.baseUrl + "/health")
).json();
const voices = await (
  await fetch(config.provider.baseUrl + "/v1/audio/voices")
).json();
const reference = voices.data.find((v) => !v.no_ref);
const cases = [
  {
    name: "melissa-design",
    voice: config.voiceProfiles[0],
    text: "ここは私に任せてください。",
  },
  {
    name: "ornithogalum-design",
    voice: config.voiceProfiles[1],
    text: "魔法の気配を感じます。",
  },
  ...(reference
    ? [
        {
          name: "registered-reference",
          voice: { ...config.voiceProfiles[0], voiceId: reference.id },
          text: "冒険の準備はできましたか？",
        },
      ]
    : []),
];
const results = [];
for (const c of cases) {
  const start = performance.now();
  const wav = await synthesize(c.text, c.voice, config.provider);
  const info = inspectWav(wav);
  writeFileSync(new URL(c.name + ".wav", out), wav);
  const result = {
    name: c.name,
    voiceId: c.voice.voiceId,
    seed: c.voice.seed,
    steps: c.voice.steps,
    bytes: wav.length,
    ...info,
    generationMs: Math.round(performance.now() - start),
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
const healthAfter = await (
  await fetch(config.provider.baseUrl + "/health")
).json();
const report = {
  at: new Date().toISOString(),
  healthBefore,
  healthAfter,
  results,
};
writeFileSync(
  new URL("irodori-report.json", out),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    loaded: healthAfter.runtime.loaded,
    checkpoint: healthAfter.runtime.checkpoint,
  }),
);
