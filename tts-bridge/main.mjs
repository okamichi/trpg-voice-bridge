import { credits } from "./src/runtime/credits.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "./src/runtime/launcher.mjs";
import { StartupSettings, launchOverrides } from "./src/runtime/startup.mjs";
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
const bridgeCredits = credits(
  readFileSync(new URL("../LICENSE", import.meta.url), "utf8"),
);
try {
  const startup = new StartupSettings({
    file: resolve(
      process.env.TTS_STARTUP_FILE ??
        fileURLToPath(new URL("./startup.json", import.meta.url)),
    ),
    defaults: {
      dataDir: resolve(fileURLToPath(new URL("./data/", import.meta.url))),
      host: "127.0.0.1",
      port: 8090,
      publicOrigin: "",
    },
    ...launchOverrides(),
  });
  await startBridge({
    startup,
    loadDefaults,
    boot: (active) => ({
      credits: bridgeCredits,
      extensions,
      localOrigin:
        process.env.TTS_LOCAL_ORIGIN ?? `http://127.0.0.1:${active.port}`,
    }),
    onListening: (app, { restarted }) => {
      if (process.stdout.isTTY)
        console.log(`管理用リンク（共有しないでください）: ${app.adminUrl()}`);
      else if (!restarted)
        console.log("管理用リンクを表示するには端末から起動してください。");
    },
  });
} catch (error) {
  if (!error?.expose) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
