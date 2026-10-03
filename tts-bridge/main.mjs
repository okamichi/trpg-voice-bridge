import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./src/http.mjs";
const port = Number(process.env.TTS_BRIDGE_PORT ?? 8090),
  host = process.env.TTS_BRIDGE_HOST ?? "127.0.0.1";
const localOrigin = process.env.TTS_LOCAL_ORIGIN ?? `http://127.0.0.1:${port}`;
const dataDir = resolve(
  process.env.TTS_DATA_DIR ?? new URL("./data/", import.meta.url).pathname,
);
const profiles = JSON.parse(
  readFileSync(new URL("./profiles.json", import.meta.url)),
);
const app = createApp({
  dataDir,
  profiles,
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
  console.log(`TRPG Voice Bridge: ${localOrigin}/admin/`);
  console.log(
    `認証情報: ${dataDir}/credentials.json （adminを管理画面、collectorを拡張へ入力）`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => app.close().then(() => process.exit(0)));
