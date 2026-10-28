import { credits } from "./src/runtime/credits.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBridge } from "./src/runtime/run.mjs";
import { exposed } from "./src/runtime/settings.mjs";
import { speechBuildMatches, speechTarget } from "./src/runtime/speech.mjs";
const local = (path) => fileURLToPath(new URL(path, import.meta.url));
const configPath = resolve(
  process.env.TTS_CONFIG_FILE ?? local("./config.json"),
);
const loadDefaults = () => JSON.parse(readFileSync(configPath));
const extensions = [];
const extensionUrl = new URL("./discord/extension.mjs", import.meta.url);
try {
  const { createExtension } = await import(extensionUrl.href);
  extensions.push(createExtension);
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== extensionUrl.href)
    console.error("拡張を読み込めませんでした。Bridgeのみ起動します。");
}
const bridgeLicense = readFileSync(local("../LICENSE"), "utf8");

// The speech.cpp build from npm run package:speech, or the one
// TTS_SPEECH_RUNTIME_DIR names. Other targets have no build: external TTS only.
function speechBuild() {
  const target = speechTarget();
  if (!target) {
    console.log("このOSでは内蔵TTSを使えません。外部TTSだけで起動します。");
    return null;
  }
  const dir = resolve(
    process.env.TTS_SPEECH_RUNTIME_DIR ?? local("./.packaging/speech-runtime/"),
  );
  let info;
  try {
    info = JSON.parse(readFileSync(join(dir, "build.json"), "utf8"));
  } catch {
    throw exposed(
      `speech.cppのビルドがありません（${dir}）。tts-bridge/ で npm run package:speech を実行してから起動してください。`,
    );
  }
  const pins = JSON.parse(
    readFileSync(local("./packaging/speech-lock.json"), "utf8"),
  );
  if (!speechBuildMatches(info, pins, target))
    throw exposed(
      `speech.cppのビルド（${dir}）が packaging/speech-lock.json と合いません。tts-bridge/ で npm run package:speech を実行し直してください。`,
    );
  return { dir, info };
}

try {
  await runBridge({
    version: () => JSON.parse(readFileSync(local("./package.json"))).version,
    layout: () => {
      const speech = speechBuild();
      return {
        startupFile: local("./startup.json"),
        dataDir: resolve(local("./data/")),
        loadDefaults,
        credits: speech
          ? credits(
              bridgeLicense,
              readFileSync(join(speech.dir, "speech.cpp-LICENSE"), "utf8"),
              speech.info.speech,
              `ほかのソフトウェアのライセンスは、${speech.dir} と、tts-bridge の node_modules・discord/node_modules にあります。`,
            )
          : credits(bridgeLicense),
        extensions,
        speechDir: speech?.dir ?? null,
        speechPlace: speech && `speech.cppのビルド（${speech.dir}）`,
      };
    },
  });
} catch (error) {
  if (!error?.expose) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
