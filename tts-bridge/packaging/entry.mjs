import { chatterDownload } from "../chatter/zip.mjs";
import { credits } from "../src/runtime/credits.mjs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { runBridge } from "../src/runtime/run.mjs";
import { readAsset } from "../src/runtime/assets.mjs";
import { createExtension } from "../discord/extension.mjs";
import { loadDependencies } from "../discord/bot.mjs";

async function selfTest() {
  chatterDownload(readAsset);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE smoke (value TEXT); INSERT INTO smoke VALUES ('ok')");
    if (db.prepare("SELECT value FROM smoke").get().value !== "ok")
      throw Error("SQLite");
  } finally {
    db.close();
  }
  const deps = await loadDependencies();
  const resource = deps.createAudioResource(
    Readable.from([Buffer.alloc(960 * 4)]),
    {
      inputType: deps.StreamType.Raw,
    },
  );
  let packets = 0;
  for await (const packet of resource.playStream) {
    if (!packet.length) throw Error("Opus");
    packets++;
  }
  if (!packets) throw Error("Opus");
  JSON.parse(readAsset("config.json"));
  console.log(
    JSON.stringify({
      sqlite: "ok",
      discord: "ok",
      opusPackets: packets,
      node: process.version,
    }),
  );
}

async function main() {
  await runBridge({
    version: () => JSON.parse(readAsset("build-info.json")).version,
    selfTest,
    layout: () => {
      const root =
        process.platform === "darwin"
          ? join(homedir(), "Library/Application Support/TRPG-Voice-Bridge")
          : join(
              process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"),
              "TRPG-Voice-Bridge",
            );
      return {
        startupFile: join(root, "startup.json"),
        dataDir: join(root, "data"),
        loadDefaults: process.env.TTS_CONFIG_FILE
          ? () => JSON.parse(readFileSync(resolve(process.env.TTS_CONFIG_FILE)))
          : () => JSON.parse(readAsset("config.json")),
        credits: credits(
          readAsset("credits/TRPG-Voice-Bridge-LICENSE").toString("utf8"),
          readAsset("credits/speech.cpp-LICENSE").toString("utf8"),
          JSON.parse(readAsset("build-info.json")).speech.speech,
        ),
        extensions: [createExtension],
        speechDir: join(dirname(process.execPath), "runtime/speech"),
      };
    },
  });
}
main().catch((error) => {
  // Do not print arbitrary configuration / library errors containing secrets.
  console.error(
    error?.expose
      ? error.message
      : error?.code === "EADDRINUSE"
        ? `Bridgeのポート${error.port ?? ""}は使用中です。--port で別のポートを指定してください。`
        : "Bridgeを起動できませんでした。ポート・保存先・設定・同梱runtimeを確認してください。",
  );
  process.exitCode = 1;
});
