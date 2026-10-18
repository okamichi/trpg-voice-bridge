import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "./src/runtime/launcher.mjs";
const port = Number(process.env.TTS_BRIDGE_PORT ?? 8090),
  host = process.env.TTS_BRIDGE_HOST ?? "127.0.0.1";
const localOrigin = process.env.TTS_LOCAL_ORIGIN ?? `http://127.0.0.1:${port}`;
const dataDir = resolve(
  process.env.TTS_DATA_DIR ??
    fileURLToPath(new URL("./data/", import.meta.url)),
);
const configPath = resolve(
  process.env.TTS_CONFIG_FILE ??
    fileURLToPath(new URL("./config.json", import.meta.url)),
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
await startBridge({
  port,
  host,
  extensions,
  dataDir,
  initial: loadDefaults(),
  loadDefaults,
  localOrigin,
  publicOrigin: process.env.TTS_PUBLIC_ORIGIN ?? "",
  onListening: (app) => {
    if (process.stdout.isTTY)
      console.log(`管理用リンク（共有しないでください）: ${app.adminUrl()}`);
    else console.log("管理用リンクを表示するには端末から起動してください。");
  },
});
