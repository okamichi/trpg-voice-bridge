import { check } from "./contracts.mjs";

// Uploads share one slot; listing voices for display never occupies that slot.
export class ReferenceVoices {
  constructor(fetchImpl) {
    this.fetch = fetchImpl;
    this.queue = [];
    this.running = null;
    this.closed = false;
    this.shutdown = new AbortController();
  }
  async list(provider, signal) {
    if (provider.type === "mock") return [{ id: "none", no_ref: true }];
    const r = await this.fetch(`${provider.baseUrl}/v1/audio/voices`, {
      signal: AbortSignal.any([
        AbortSignal.timeout(5000),
        this.shutdown.signal,
        ...(signal ? [signal] : []),
      ]),
    });
    check(r.ok, "参照voice一覧の取得失敗", 502);
    const data = await r.json();
    return (data.data ?? []).map((v) => ({ id: v.id, no_ref: v.no_ref }));
  }
  register({
    provider,
    voiceId,
    wav,
    signal,
    wait = false,
    before = () => {},
  }) {
    check(!this.closed, "アプリ終了中です", 503);
    check(provider.type !== "mock", "モックでは参照音声を登録できません", 409);
    check(
      typeof voiceId === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(voiceId) &&
        !["none", "no_ref", "no-ref", "null", "text-only"].includes(
          voiceId.toLowerCase(),
        ),
      "参照音声IDが不正です",
    );
    check(
      wait || (!this.running && !this.queue.length),
      "他の参照音声を登録中です。少し待って再試行してください",
      429,
    );
    return new Promise((resolve, reject) => {
      const task = {
        provider: structuredClone(provider),
        voiceId,
        wav,
        signal,
        before,
        resolve,
        reject,
      };
      task.cancel = () => {
        const index = this.queue.indexOf(task);
        if (index >= 0) {
          this.queue.splice(index, 1);
          task.cleanup();
          reject(signal?.reason ?? new Error("参照音声登録を中断しました"));
        }
      };
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(task);
        if (index >= 0) {
          this.queue.splice(index, 1);
          task.cleanup();
          reject(new Error("参照音声登録の待機期限が切れました"));
        }
      }, 180000);
      timer.unref();
      task.cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", task.cancel);
      };
      this.queue.push(task);
      signal?.addEventListener("abort", task.cancel, { once: true });
      if (signal?.aborted) task.cancel();
      this.pump();
    });
  }
  pump() {
    if (this.running || this.closed) return;
    const task = this.queue.shift();
    if (!task) return;
    task.cleanup();
    const run = async () => {
      try {
        task.signal?.throwIfAborted();
        task.before();
        const signal = AbortSignal.any([
          this.shutdown.signal,
          ...(task.signal ? [task.signal] : []),
        ]);
        const taken = "同じIDの参照音声が既にあります。別のIDにしてください";
        check(
          !(await this.list(task.provider, signal)).some(
            (v) => v.id === task.voiceId,
          ),
          taken,
          409,
        );
        signal.throwIfAborted();
        task.before();
        const form = new FormData();
        form.append(
          "file",
          new Blob([task.wav], { type: "audio/wav" }),
          `${task.voiceId}.wav`,
        );
        form.append("voice_id", task.voiceId);
        const r = await this.fetch(`${task.provider.baseUrl}/v1/audio/voices`, {
          method: "POST",
          body: form,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });
        await r.body?.cancel();
        check(r.status !== 409, taken, 409);
        check(
          r.ok,
          `参照音声の登録に失敗しました（TTS HTTP ${r.status}）`,
          502,
        );
        task.resolve({ id: task.voiceId });
      } catch (error) {
        task.reject(error);
      }
    };
    this.running = run().finally(() => {
      this.running = null;
      this.pump();
    });
  }
  async close() {
    this.closed = true;
    this.shutdown.abort(new Error("アプリ終了で中断しました"));
    for (const task of this.queue.splice(0)) {
      task.cleanup();
      task.reject(new Error("アプリ終了で中断しました"));
    }
    await this.running;
  }
}
