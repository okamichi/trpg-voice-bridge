import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { exposed } from "./settings.mjs";
import { speechLifecycle } from "./speech.mjs";
import { startBridge } from "./launcher.mjs";
import { StartupSettings, launchOverrides } from "./startup.mjs";

function openBrowser(url) {
  return new Promise((resolve, reject) => {
    // No shell interpolation: the URL contains a short-lived admin credential.
    const [command, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
          : [];
    if (!command) return reject(Error("browser"));
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error("browser")),
    );
  });
}

// Runs Bridge the same way from the package and from the source tree. Only
// layout() differs between them; it is read once the options ask for a start:
// startupFile, dataDir (the default), loadDefaults, credits, extensions, and
// speechDir with speechPlace (null speechDir: external TTS only).
export async function runBridge({
  args = process.argv.slice(2),
  version,
  selfTest,
  layout,
}) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean" },
      version: { type: "boolean" },
      "no-browser": { type: "boolean" },
      ...(selfTest ? { "self-test": { type: "boolean" } } : {}),
      "data-dir": { type: "string" },
      port: { type: "string" },
      tts: { type: "string" },
      model: { type: "string" },
      "tts-port": { type: "string" },
      "tts-backend": { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      `TRPG Voice Bridge\n--help --version --no-browser --data-dir <path> --port <1-65535>${selfTest ? " --self-test" : ""}\n--tts <external|bundled> --model <absolute.gguf> --tts-port <1-65535>\n--tts-backend <vulkan|cpu> (Windows)`,
    );
    return;
  }
  if (values.version) {
    console.log(version());
    return;
  }
  if (values["self-test"]) {
    await selfTest();
    return;
  }
  const {
    startupFile,
    dataDir,
    loadDefaults,
    credits,
    extensions,
    speechDir,
    speechPlace,
  } = layout();
  const startup = new StartupSettings({
    file: resolve(process.env.TTS_STARTUP_FILE ?? startupFile),
    defaults: {
      dataDir,
      host: "127.0.0.1",
      port: 8090,
      publicOrigin: "",
    },
    ...launchOverrides(process.env, {
      dataDir: values["data-dir"],
      port: values.port,
    }),
  });
  // Launch options for the bundled TTS apply to every start of this process.
  const ttsOverrides = {
    ...(values.tts !== undefined ? { mode: values.tts } : {}),
    ...(values.model !== undefined ? { model: values.model } : {}),
    ...(values["tts-port"] !== undefined
      ? { ttsPort: Number(values["tts-port"]) }
      : {}),
    ...(values["tts-backend"] !== undefined
      ? { backend: values["tts-backend"] }
      : {}),
  };
  if (!speechDir && Object.keys(ttsOverrides).length)
    throw exposed(
      "このOSでは内蔵TTSを使えないため、--tts・--model・--tts-port・--tts-backend は指定できません",
    );
  const speech = speechDir
    ? speechLifecycle({
        runtimeDir: speechDir,
        overrides: ttsOverrides,
        place: speechPlace,
      })
    : null;
  const options = (active) => ({
    credits,
    extensions,
    localOrigin:
      process.env.TTS_LOCAL_ORIGIN ?? `http://127.0.0.1:${active.port}`,
  });
  return startBridge({
    startup,
    loadDefaults,
    prepare: speech?.prepare,
    boot: speech
      ? (active, prepared) =>
          speech.boot(active, prepared, (runtime) => ({
            ...options(active),
            providerOptions: {
              resolveProvider: (saved) => runtime.provider(saved),
              fetchImpl: runtime.fetch,
            },
          }))
      : options,
    onListening: async (app, { restarted }) => {
      const runtime = speech?.runtime;
      if (runtime)
        void runtime
          .start()
          .catch(() => runtime.fail("内蔵TTSを開始できませんでした"));
      console.log(`Bridge ready: http://127.0.0.1:${startup.active.port}/`);
      // After a restart the admin page moves to the new address itself.
      let manual = values["no-browser"] || restarted;
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
        else if (!restarted)
          console.log(
            "管理用リンクを表示するには端末から --no-browser で起動してください。",
          );
      }
    },
  });
}
