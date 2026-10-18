import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { SpeechRuntime } from "../src/runtime/speech.mjs";
import { startBridge } from "../src/runtime/launcher.mjs";
import { readAsset } from "../src/runtime/assets.mjs";
import { createExtension } from "../discord/extension.mjs";
import { loadDependencies } from "../discord/bot.mjs";

async function selfTest() {
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

function openBrowser(url) {
  return new Promise((resolve, reject) => {
    // No shell interpolation: the URL contains a short-lived admin credential.
    const command = process.platform === "darwin" ? "open" : "rundll32.exe";
    const args =
      process.platform === "darwin"
        ? [url]
        : ["url.dll,FileProtocolHandler", url];
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error("browser")),
    );
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      version: { type: "boolean" },
      "no-browser": { type: "boolean" },
      "self-test": { type: "boolean" },
      "data-dir": { type: "string" },
      port: { type: "string" },
      tts: { type: "string" },
      model: { type: "string" },
      "tts-port": { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "TRPG Voice Bridge (bundled TTS preview)\n--help --version --no-browser --data-dir <path> --port <1-65535> --self-test\n--tts <external|bundled> --model <absolute.gguf> --tts-port <1-65535>",
    );
    return;
  }
  if (values.version) {
    console.log(JSON.parse(readAsset("build-info.json")).version);
    return;
  }
  if (values["self-test"]) {
    await selfTest();
    return;
  }
  const port = Number(values.port ?? process.env.TTS_BRIDGE_PORT ?? 8090);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("port");
  const root =
    process.platform === "darwin"
      ? join(homedir(), "Library/Application Support/TRPG-Voice-Bridge")
      : join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"),
          "TRPG-Voice-Bridge",
        );
  const dataDir = resolve(
    values["data-dir"] ?? process.env.TTS_DATA_DIR ?? join(root, "data"),
  );
  const loadDefaults = process.env.TTS_CONFIG_FILE
    ? () => JSON.parse(readFileSync(resolve(process.env.TTS_CONFIG_FILE)))
    : () => JSON.parse(readAsset("config.json"));
  const initial = loadDefaults();
  const runtime = new SpeechRuntime({
    dataDir,
    runtimeDir: join(dirname(process.execPath), "runtime/speech"),
    overrides: {
      ...(values.tts !== undefined ? { mode: values.tts } : {}),
      ...(values.model !== undefined ? { model: values.model } : {}),
      ...(values["tts-port"] !== undefined
        ? { ttsPort: Number(values["tts-port"]) }
        : {}),
    },
  });
  await runtime.acquire();
  await startBridge({
    runtime,
    onClose: () => runtime.close(),
    providerOptions: {
      resolveProvider: (saved) => runtime.provider(saved),
      fetchImpl: runtime.fetch,
    },
    port,
    host: process.env.TTS_BRIDGE_HOST ?? "127.0.0.1",
    dataDir,
    initial,
    loadDefaults,
    extensions: [createExtension],
    localOrigin: process.env.TTS_LOCAL_ORIGIN ?? `http://127.0.0.1:${port}`,
    publicOrigin: process.env.TTS_PUBLIC_ORIGIN ?? "",
    onListening: async (app) => {
      void runtime
        .start()
        .catch(() => runtime.fail("内蔵TTSを開始できませんでした"));
      console.log(`Bridge ready: http://127.0.0.1:${port}/`);
      let manual = values["no-browser"];
      if (!manual) {
        try {
          await openBrowser(app.adminUrl());
        } catch {
          manual = true;
        }
      }
      if (manual) {
        if (process.stdout.isTTY)
          console.log(
            `管理用リンク（共有しないでください）: ${app.adminUrl()}`,
          );
        else
          console.log(
            "管理用リンクを表示するには端末から --no-browser で起動してください。",
          );
      }
    },
  });
}
main().catch(() => {
  // Do not print arbitrary configuration / library errors containing secrets.
  console.error(
    "Bridgeを起動できませんでした。ポート・保存先・設定・同梱runtimeを確認してください。",
  );
  process.exitCode = 1;
});
