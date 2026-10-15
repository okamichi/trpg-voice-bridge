import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./src/http.mjs";
const port = Number(process.env.TTS_BRIDGE_PORT ?? 8090),
  host = process.env.TTS_BRIDGE_HOST ?? "127.0.0.1";
const localOrigin = process.env.TTS_LOCAL_ORIGIN ?? `http://127.0.0.1:${port}`;
const dataDir = resolve(
  process.env.TTS_DATA_DIR ?? new URL("./data/", import.meta.url).pathname,
);
const configPath = resolve(
  process.env.TTS_CONFIG_FILE ??
    new URL("./config.json", import.meta.url).pathname,
);
const loadDefaults = () => JSON.parse(readFileSync(configPath));
const initial = loadDefaults();
const extensions = [];
const extensionUrl = new URL("./discord/extension.mjs", import.meta.url);
try {
  const { createExtension } = await import(extensionUrl.href);
  extensions.push(createExtension);
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== extensionUrl.href)
    console.error("拡張を読み込めませんでした。Bridgeのみ起動します。");
}
const app = createApp({
  extensions,
  dataDir,
  initial,
  loadDefaults,
  localOrigin,
  publicOrigin: process.env.TTS_PUBLIC_ORIGIN ?? "",
});
app.engine.on("notification", (message) => {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      type: message.type,
      roomId: message.roomId,
      orderId: message.orderId,
      orderSeq: message.orderSeq,
      status: message.status,
      playbackEpoch: message.playbackEpoch,
    }),
  );
});
app.server.listen(port, host, () => {
  console.log(`管理用リンク（共有しないでください）: ${app.adminUrl()}`);
});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    app.close().then(() => process.exit(0));
  });
