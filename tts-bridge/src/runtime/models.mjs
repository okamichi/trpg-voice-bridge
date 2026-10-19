import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

const unavailable =
  "同梱のspeechを起動できません。展開したフォルダのruntime/speechを確認してください。";
const failure = (message, status = 500) =>
  Object.assign(Error(message), { status });
const active = (job) =>
  ["starting", "running", "stopping"].includes(job?.status);

export class SpeechModels {
  constructor({ dataDir, speech, supervisor }) {
    this.dataDir = dataDir;
    this.speech = speech;
    this.supervisor = supervisor;
    this.pending = new Map();
    this.children = new Set();
    this.dir = "";
    mkdirSync(dataDir, { recursive: true });
    this.settingsPath = join(dataDir, "models.json");
    try {
      const { dir } = JSON.parse(readFileSync(this.settingsPath, "utf8"));
      this.validateDir(dir);
      this.dir = dir;
    } catch (e) {
      if (e.code !== "ENOENT")
        this.settingsError =
          "models.jsonを確認するか、保存先を設定し直してください。";
    }
  }
  validateDir(dir) {
    if (
      typeof dir !== "string" ||
      (dir && !isAbsolute(dir)) ||
      dir.includes("\0")
    )
      throw failure("保存先は絶対パスを指定してください。", 400);
  }
  env(dir) {
    return { ...process.env, ...(dir ? { SPEECH_MODEL_DIR: dir } : {}) };
  }
  catalog(dir) {
    if (this.closing) return Promise.reject(failure("Bridgeは終了中です", 409));
    if (this.pending.has(dir)) return this.pending.get(dir);
    const promise = new Promise((resolve, reject) => {
      const child = spawn(
        this.speech[0],
        [...this.speech.slice(1), "models", "--json"],
        {
          env: this.env(dir),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.children.add(child);
      let output = "",
        error;
      const timer = setTimeout(() => {
        error = failure("モデル一覧の取得がタイムアウトしました。");
        child.kill("SIGKILL");
      }, 30000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.length > 8 * 1024 * 1024) {
          error = failure("モデル一覧が大きすぎます。");
          child.kill("SIGKILL");
        }
      });
      child.stderr.resume();
      child.on("error", () => {
        error = failure(unavailable);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (error || code !== 0)
          return reject(error ?? failure("モデル一覧を取得できませんでした。"));
        try {
          const data = JSON.parse(output);
          if (!isAbsolute(data.directory) || !Array.isArray(data.models))
            throw Error();
          resolve(data);
        } catch {
          reject(failure("モデル一覧の形式が不正です。"));
        }
      });
    });
    this.pending.set(dir, promise);
    const clear = () => this.pending.delete(dir);
    promise.then(clear, clear);
    return promise;
  }
  async defaultDirectory() {
    if (!this.defaultDir) this.defaultDir = (await this.catalog("")).directory;
    return this.defaultDir;
  }
  models(data) {
    return data.models
      .filter((m) => ["irodori-tts", "irodori-tts-large"].includes(m.name))
      .flatMap((m) =>
        m.files
          .filter((f) => ["q8_0", "q6_k", "q5_k", "q4_k"].includes(f.type))
          .map((f) => ({
            choice: `${m.name}:${f.type}`,
            label: `${m.repository
              .split("/")
              .at(-1)
              .replace(/-GGUF$/, "")} ${f.type.toUpperCase()}`,
            size: f.size,
            path: f.path,
            url: f.url,
            fetched: f.fetched,
            partial: f.partial,
            gemma: m.name === "irodori-tts-large",
          })),
      );
  }
  async list() {
    if (this.settingsError) throw failure(this.settingsError);
    const dir = this.dir;
    const [defaultDir, data] = await Promise.all([
      this.defaultDirectory(),
      this.catalog(dir),
    ]);
    // A directory change while the subprocess ran invalidates this snapshot.
    if (dir !== this.dir) return this.list();
    return {
      defaultDir,
      dir: data.directory,
      models: this.models(data),
      pull: this.job ? { ...this.job } : null,
    };
  }
  async setDir(dir) {
    this.validateDir(dir);
    if (this.closing || active(this.job))
      throw failure("ダウンロード中は保存先を変更できません。", 409);
    const defaultDir = await this.defaultDirectory();
    if (this.closing || active(this.job))
      throw failure("ダウンロード中は保存先を変更できません。", 409);
    const next = dir === defaultDir ? "" : dir;
    writeFileSync(
      `${this.settingsPath}.tmp`,
      JSON.stringify({ dir: next }) + "\n",
      { mode: 0o600 },
    );
    renameSync(`${this.settingsPath}.tmp`, this.settingsPath);
    this.dir = next;
    this.settingsError = undefined;
  }
  async pull(choice) {
    if (this.closing || active(this.job))
      throw failure("ダウンロード中です。", 409);
    const dir = this.dir;
    const job = (this.job = {
      id: randomUUID(),
      choice,
      dir,
      status: "starting",
    });
    let prepared;
    this.finished = new Promise((resolve) => {
      prepared = resolve;
    });
    try {
      if (this.settingsError) throw failure(this.settingsError);
      const data = await this.catalog(dir);
      job.dir = data.directory;
      if (job.status === "stopping" || this.closing) {
        job.status = "cancelled";
        return { id: job.id };
      }
      if (!this.models(data).some((m) => m.choice === choice))
        throw failure("一覧にないモデルです。", 400);
      // Reserve the job before validation awaits; release only after helper cleanup.
      this.finished = this.execute(job);
      return { id: job.id };
    } catch (e) {
      job.status = job.status === "stopping" ? "cancelled" : "error";
      job.error = e.message;
      throw e;
    } finally {
      prepared();
    }
  }
  async execute(job) {
    let result,
      lastError = "",
      tail = "",
      startupError,
      timedOut = false,
      childPid;
    const helper = (this.helper = spawn(
      this.supervisor,
      [
        join(this.dataDir, "model-pull.lock"),
        ...this.speech,
        "pull",
        job.choice,
      ],
      {
        env: this.env(job.dir),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ));
    helper.stdin.on("error", () => {});
    helper.stderr.setEncoding("utf8");
    helper.stderr.on("data", (chunk) => {
      tail += chunk;
      const lines = tail.split(/\r?\n/);
      tail = lines.pop().slice(-8192);
      for (const line of lines)
        if (line.startsWith("speech: ")) lastError = line.slice(0, 8192);
    });
    let stopTimer;
    this.stopHelper = () => {
      if (stopTimer) return;
      // Q/EOF waits for tree cleanup on both OSes. macOS T reaps without an exited event.
      helper.stdin.end("Q");
      stopTimer = setTimeout(() => {
        timedOut = true;
        if (process.platform !== "win32" && childPid) {
          try {
            process.kill(-childPid, "SIGKILL");
          } catch {
            /* Already gone. */
          }
        }
        helper.kill("SIGKILL");
      }, 10000);
    };
    const startupTimer = setTimeout(() => {
      startupError = unavailable;
      this.stopHelper();
    }, 10000);
    const lines = createInterface({ input: helper.stdout });
    lines.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.event === "locked") {
        if (job.status === "stopping") this.stopHelper();
        else helper.stdin.write("S");
      }
      if (event.event === "spawned") {
        if (Number.isInteger(event.pid) && event.pid > 0) childPid = event.pid;
        clearTimeout(startupTimer);
        if (job.status !== "stopping") job.status = "running";
      }
      if (["spawn-error", "lock-error"].includes(event.event)) {
        startupError = unavailable;
        this.stopHelper();
      }
      if (event.event === "exited") {
        clearTimeout(startupTimer);
        childPid = undefined;
        result = event.code;
        this.stopHelper();
      }
    });
    await new Promise((resolve) => {
      helper.once("error", () => {
        startupError = unavailable;
      });
      helper.once("close", resolve);
    });
    clearTimeout(startupTimer);
    clearTimeout(stopTimer);
    this.helper = undefined;
    this.stopHelper = undefined;
    try {
      if (timedOut) throw failure("ダウンロードを止められませんでした");
      if (job.status === "stopping") {
        job.status = "cancelled";
        return;
      }
      if (startupError) throw failure(startupError);
      if (result !== 0)
        throw failure(
          lastError ||
            (tail.startsWith("speech: ")
              ? tail
              : "ダウンロードに失敗しました。"),
        );
      // Never reuse a catalog started before the child finished renaming the file.
      await this.pending.get(job.dir)?.catch(() => {});
      const model = this.models(await this.catalog(job.dir)).find(
        (m) => m.choice === job.choice,
      );
      if (job.status === "stopping") {
        job.status = "cancelled";
        return;
      }
      if (!model?.fetched) throw failure("取得したファイルが見つかりません");
      job.path = model.path;
      job.status = "done";
    } catch (e) {
      job.status =
        job.status === "stopping" && !timedOut ? "cancelled" : "error";
      job.error = e.message;
    }
  }
  async cancel() {
    if (!active(this.job)) return;
    this.job.status = "stopping";
    this.stopHelper?.();
    await this.finished;
  }
  async close() {
    this.closing = true;
    for (const child of this.children) child.kill("SIGKILL");
    await this.cancel();
    await Promise.allSettled([...this.pending.values()]);
  }
}
