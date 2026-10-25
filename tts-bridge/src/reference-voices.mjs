import { check } from "./contracts.mjs";
import {
  ReferenceStore,
  referenceId,
  referenceTarget,
} from "./reference-store.mjs";
import { remoteVoices, uploadVoice } from "./tts-api.mjs";

// Uploads share one slot; listing voices for display never occupies that slot.
export class ReferenceVoices {
  constructor(fetchImpl = fetch, dataDir) {
    this.fetch = fetchImpl;
    this.store = dataDir ? new ReferenceStore(dataDir) : null;
    this.operations = Promise.resolve();
    this.problems = new Map();
    this.restorations = new Map();
    this.queue = [];
    this.running = null;
    this.closed = false;
    this.shutdown = new AbortController();
  }
  async list(provider, signal) {
    check(!this.closed, "アプリ終了中です", 503);
    const remote = await remoteVoices(
      provider,
      this.fetch,
      this.signal(signal),
    );
    if (provider.type === "mock") return remote.voices;
    const { records, issues } = this.scan(provider);
    for (const [id, entry] of Object.entries(records)) {
      if (id === this.uploadingId) continue;
      if (remote.voices.some((v) => v.id === id)) {
        if (!this.store.bound(id, provider))
          this.problem(provider, this.conflict(id, entry));
        else if (this.problem(provider, id)?.kind !== "file")
          this.clear(provider, id);
      } else if (!this.problem(provider, id))
        this.problem(provider, {
          id,
          kind: "pending",
          message: `参照音声「${id}」は接続先に未登録です。再確認・復元を実行してください`,
        });
    }
    const blocked = new Set(
      [...issues, ...this.diagnostics(provider)].map((p) => p.id),
    );
    return remote.voices.filter(
      (v) =>
        v.id !== this.uploadingId &&
        (!blocked.has(v.id) || this.store?.bound(v.id, provider)),
    );
  }
  signal(signal) {
    return AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]);
  }
  scan(provider) {
    return provider.type === "mock" || !this.store
      ? { entries: {}, issues: [], records: {} }
      : this.store.scan();
  }
  problem(provider, value) {
    const target = referenceTarget(provider);
    if (!this.problems.has(target)) this.problems.set(target, new Map());
    const problems = this.problems.get(target);
    if (typeof value === "string") return problems.get(value);
    problems.set(value.id, value);
  }
  clear(provider, id) {
    this.problems.get(referenceTarget(provider))?.delete(id);
  }
  progress(provider) {
    const progress = this.restorations.get(referenceTarget(provider));
    return progress ? { ...progress } : null;
  }
  diagnostics(provider) {
    if (provider.type === "mock") return [];
    let scan;
    try {
      scan = this.scan(provider);
    } catch {
      return [
        {
          id: "",
          kind: "ledger",
          message:
            "参照音声の管理情報を読み込めません。reference-voices.jsonとvoicesフォルダーを確認してください。破損している場合は元ファイルを保管し、バックアップから修復してください。他の状態表示は継続しています",
        },
      ];
    }
    const { records, issues } = scan;
    const result = new Map(
      [...(this.problems.get(referenceTarget(provider))?.values() ?? [])]
        .filter((p) => Object.hasOwn(records, p.id))
        .map((p) => [p.id, { ...p, sha256: records[p.id].sha256 }]),
    );
    for (const issue of issues) result.set(issue.id, issue);
    return [...result.values()];
  }
  conflict(id, entry) {
    return {
      id,
      kind: "conflict",
      sha256: entry.sha256,
      message: `接続先の参照音声「${id}」と保存済み音声が衝突しています。同じ音声か管理画面で確認してください`,
    };
  }
  async adopt(provider, id, sha256, before = () => {}) {
    check(!this.closed && this.store, "参照音声の管理を利用できません", 503);
    check(referenceId(id), "参照音声IDが不正です");
    return this.exclusive(async () => {
      before();
      const entry = this.store.entries()[id];
      check(
        entry && entry.sha256 === sha256,
        "保存音声が変更されています。再確認してください",
        409,
      );
      this.store.wav(id, entry.sha256);
      const remote = await remoteVoices(provider, this.fetch, this.signal());
      check(
        remote.voices.some((v) => v.id === id),
        "接続先にその音声がありません",
        409,
      );
      before();
      check(
        this.store.entries()[id]?.sha256 === sha256,
        "保存音声が変更されています。再確認してください",
        409,
      );
      this.store.wav(id, sha256);
      this.store.bind(id, provider);
      this.clear(provider, id);
    });
  }
  async forget(id, sha256, before = () => {}) {
    check(!this.closed && this.store, "参照音声の管理を利用できません", 503);
    return this.exclusive(() => {
      before();
      check(
        id !== this.uploadingId && !this.queue.some((t) => t.voiceId === id),
        "この音声は登録中です。完了してから再試行してください",
        409,
      );
      this.store.forget(id, sha256);
      for (const problems of this.problems.values()) problems.delete(id);
    });
  }
  exclusive(fn) {
    const next = this.operations.then(fn);
    this.operations = next.catch(() => {});
    return next;
  }
  needsPreparation(provider, voiceId) {
    if (provider.type === "speech") return true;
    if (provider.type === "mock" || !referenceId(voiceId)) return false;
    const { entries, issues } = this.scan(provider);
    return (
      Object.hasOwn(entries, voiceId) || issues.some((p) => p.id === voiceId)
    );
  }
  async prepare(provider, signal, voiceId) {
    check(!this.closed, "アプリ終了中です", 503);
    signal = this.signal(signal);
    const initial = this.scan(provider);
    // Irodori needs no extra round-trip for synthesis without a managed voice.
    if (
      voiceId &&
      !Object.hasOwn(initial.records, voiceId) &&
      !initial.issues.some((p) => p.id === voiceId) &&
      provider.type !== "speech"
    )
      return {};
    const restore = async () => {
      const progress = {
        state: "running",
        completed: 0,
        total: Object.keys(initial.records).filter((id) =>
          voiceId ? id === voiceId : id !== this.uploadingId,
        ).length,
        failed: 0,
      };
      if (provider.type === "speech" && !voiceId)
        this.restorations.set(referenceTarget(provider), progress);
      try {
        signal.throwIfAborted();
        let remote = await remoteVoices(provider, this.fetch, signal);
        // Refresh under the mutation lock: a queued detach or a new registration
        // may have changed this record since prepare() was called.
        const { records, issues } = this.scan(provider);
        const localProblem = issues.find((p) => p.id === voiceId);
        check(
          !localProblem ||
            (remote.voices.some((v) => v.id === voiceId) &&
              this.store.bound(voiceId, provider)),
          localProblem?.message,
          409,
        );
        const selected = Object.entries(records).filter(([id]) =>
          voiceId ? id === voiceId : id !== this.uploadingId,
        );
        progress.total = selected.length;
        if (
          provider.type === "speech" &&
          voiceId &&
          selected.some(([id]) => !remote.voices.some((v) => v.id === id))
        )
          this.restorations.set(referenceTarget(provider), progress);
        let changed = false;
        for (const [id, entry] of selected) {
          signal.throwIfAborted();
          let kind = "file";
          try {
            if (remote.voices.some((v) => v.id === id)) {
              kind = "conflict";
              check(
                this.store.bound(id, provider),
                this.conflict(id, entry).message,
                409,
              );
              if (this.problem(provider, id)?.kind !== "file")
                this.clear(provider, id);
              continue;
            }
            const issue = issues.find((p) => p.id === id);
            check(!issue, issue?.message, 409);
            const wav = this.store.wav(id, entry.sha256);
            kind = "upload";
            await uploadVoice(provider, id, wav, this.fetch, signal);
            this.store.bind(id, provider);
            this.clear(provider, id);
            changed = true;
          } catch (error) {
            signal.throwIfAborted();
            progress.failed++;
            this.problem(provider, {
              id,
              kind,
              message: error.message,
              ...(kind === "conflict" ? { sha256: entry.sha256 } : {}),
            });
            if (voiceId) throw error;
          } finally {
            progress.completed++;
          }
        }
        if (changed) remote = await remoteVoices(provider, this.fetch, signal);
        progress.state = "completed";
        return remote;
      } catch (error) {
        progress.state = "failed";
        throw error;
      }
    };
    return Object.keys(initial.records).length || initial.issues.length
      ? this.exclusive(restore)
      : remoteVoices(provider, this.fetch, signal);
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
    check(referenceId(voiceId), "参照音声IDが不正です");
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
    this.uploadingId = task.voiceId;
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
        await this.exclusive(async () => {
          check(
            !(
              await remoteVoices(task.provider, this.fetch, signal)
            ).voices.some((v) => v.id === task.voiceId),
            taken,
            409,
          );
          signal.throwIfAborted();
          task.before();
          const receipt = this.store?.save(task.voiceId, task.wav);
          task.saved = Boolean(this.store);
          try {
            await uploadVoice(
              task.provider,
              task.voiceId,
              task.wav,
              this.fetch,
              signal,
            );
          } catch (error) {
            if (error.notRegistered && receipt) {
              this.store.rollback(receipt);
              task.saved = false;
              this.clear(task.provider, task.voiceId);
            }
            throw error;
          }
          this.store?.bind(task.voiceId, task.provider);
          this.clear(task.provider, task.voiceId);
        });
        task.resolve({ id: task.voiceId });
      } catch (error) {
        if (task.saved)
          this.problem(task.provider, {
            id: task.voiceId,
            kind: "upload",
            message: error.message,
          });
        task.reject(error);
      }
    };
    this.running = run().finally(() => {
      this.running = null;
      this.uploadingId = null;
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
    await this.operations;
  }
}
