const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = process.argv[2];
const dir = process.env.SPEECH_MODEL_DIR || path.join(root, "既定 models");
const mode = () => {
  try {
    return fs.readFileSync(path.join(root, "mode"), "utf8");
  } catch {
    return "";
  }
};
const file = (name, type) => path.join(dir, `${name}-${type}.gguf`);
if (process.argv[3] === "models") {
  setTimeout(
    () => {
      const models = [
        "irodori-tts",
        "irodori-tts-large",
        "irodori-tts-mf",
        "qwen3-tts",
      ].map((name) => ({
        name,
        repository: `owner/${name}-GGUF`,
        files: ["q8_0", "q6_k", "q5_k", "q4_k", "f16"].map((type) => {
          const p = file(name, type);
          return {
            type,
            size: 10000,
            path: p,
            url: "https://example.invalid/model",
            fetched: fs.existsSync(p),
            partial: fs.existsSync(p + ".part")
              ? fs.statSync(p + ".part").size
              : 0,
          };
        }),
      }));
      console.log(JSON.stringify({ directory: dir, models }));
    },
    mode() === "slow" ? 350 : 20,
  );
} else {
  const [name, type] = process.argv[4].split(":");
  fs.mkdirSync(dir, { recursive: true });
  const p = file(name, type);
  if (mode() === "error") {
    console.error("speech: io: test failure");
    process.exit(1);
  }
  if (mode() === "missing") process.exit(0);
  if (mode() === "tree") {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    // The parent treats existence as readiness. Publish only complete JSON;
    // another process can observe a writeFileSync destination before its write.
    const pids = path.join(root, "pids");
    fs.writeFileSync(pids + ".tmp", JSON.stringify([process.pid, child.pid]));
    fs.renameSync(pids + ".tmp", pids);
    setInterval(() => {}, 1000);
  } else {
    let size = fs.existsSync(p + ".part") ? fs.statSync(p + ".part").size : 0;
    const timer = setInterval(() => {
      size += 1000;
      fs.writeFileSync(p + ".part", Buffer.alloc(size));
      if (size >= 10000) {
        clearInterval(timer);
        fs.renameSync(p + ".part", p);
        console.log(p);
      }
    }, 180);
  }
}
