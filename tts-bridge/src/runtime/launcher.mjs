import { createApp } from "../http.mjs";

export async function startBridge({
  port,
  host,
  onListening,
  onClose,
  ...options
}) {
  let app;
  try {
    app = createApp({ ...options, onShutdown: () => signal() });
  } catch (e) {
    await onClose?.();
    throw e;
  }
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
  let closing;
  const stop = () => (closing ??= app.close().finally(() => onClose?.()));
  const signal = () => {
    stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  if (options.runtime) {
    options.runtime.onFatal = signal;
  }
  for (const name of ["SIGINT", "SIGTERM"]) process.once(name, signal);
  try {
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(port, host, () => {
        app.server.off("error", reject);
        resolve();
      });
    });
    await onListening?.(app);
    return app;
  } catch (error) {
    for (const name of ["SIGINT", "SIGTERM"]) process.off(name, signal);
    await stop();
    throw error;
  }
}
