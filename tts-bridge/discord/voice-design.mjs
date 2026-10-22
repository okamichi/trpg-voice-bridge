import { check, hash, voiceSchema } from "../src/contracts.mjs";
import { AUDIO_LIMIT } from "../src/provider.mjs";
import { encodeOggOpus, loadOpus } from "../src/audio-format.mjs";

const row = (...components) => ({ type: 1, components });
const button = (custom_id, label, disabled = false, style = 2) => ({
  type: 2,
  custom_id,
  label,
  disabled,
  style,
});
const basic = [
  ["name", "声の名前", 200],
  ["caption", "声の説明", 1000],
  ["speed", "話す速度（0.5〜2）", 10],
  ["sample", "試聴するセリフ", 500],
];
const advanced = [
  ["seed", "seed（0〜9223372036854775807）", 19],
  ["steps", "生成ステップ数（1〜100）", 3],
  ["cfgScaleText", "テキストCFG（空欄または0〜10）", 10],
  ["cfgScaleCaption", "説明CFG（空欄または0〜10）", 10],
  ["cfgScaleSpeaker", "参照音声CFG（空欄または0〜10）", 10],
];
const safe = (value) =>
  String(value)
    .replace(/[\\`*_~|<>@]/g, "")
    .slice(0, 1000);

// The bot and Engine live in the same process. Only Discord UI events cross
// the network; neither a public Bridge URL nor an interaction webhook is used.
export class VoiceDesign {
  constructor({ client, engine, settings, report = () => {}, ttl = 600000 }) {
    Object.assign(this, { client, engine, settings, report, ttl });
    this.sessions = new Map();
    this.closed = false;
    this.listener = (interaction) => {
      if (interaction.customId?.startsWith("vd:"))
        void this.handle(interaction);
    };
    client.on("interactionCreate", this.listener);
  }
  id(s, action) {
    return `vd:${s.task.job.id}:${s.version}:${action}`;
  }
  validate(s) {
    check(
      !this.closed && this.sessions.get(s.task.job.id) === s,
      "このフォームは期限切れです",
      409,
    );
    s.valid();
    const current = this.settings();
    check(
      current.enabled &&
        current.guildId === s.guildId &&
        current.channelId === s.channelId,
      "声デザイン設定が変更されました",
      409,
    );
  }
  payload(s, replaceAudio = false) {
    const disabled = s.busy || s.done;
    const data = {
      content: `**${safe(s.task.character.displayName)}の声づくり** — 候補 ${s.candidate}\n${safe(s.notice)}\n声の名前：${safe(s.voice.name)}\n説明：${safe(s.voice.caption).slice(0, 700)}`,
      allowedMentions: { parse: [] },
      components: s.done
        ? []
        : [
            row(
              button(this.id(s, "basic"), "基本設定", disabled),
              button(this.id(s, "advanced"), "詳細設定", disabled),
              button(this.id(s, "voices0"), "既存の声", disabled),
              button(this.id(s, "refs0"), "参照音声", disabled),
            ),
            row(
              button(
                this.id(s, "generate"),
                "変更を反映し再生声",
                disabled || !s.dirty,
              ),
              button(
                this.id(s, "confirm"),
                "この声に決定",
                disabled || !s.wav || s.dirty,
                3,
              ),
              button(this.id(s, "cancel"), "取消", s.done, 4),
            ),
          ],
    };
    if (!s.done && s.audioStatus)
      data.content += `\n\n**${s.audioStatus}**\n受付：<t:${Math.floor(s.audioStarted / 1000)}:R>`;
    if (replaceAudio || s.done) {
      data.attachments = [];
      if (replaceAudio && s.upload && !s.done)
        data.files = [
          { attachment: s.upload, name: `preview-${s.candidate}.${s.format}` },
        ];
    }
    return data;
  }
  async publish(s, replaceAudio = false) {
    if (!s.message) return;
    // A cancellation may arrive while an upload is in flight. Serialize edits
    // and render at send time so the final disabled message always wins.
    const work = (s.publishTail ?? Promise.resolve())
      .catch(() => {})
      .then(() => s.message.edit(this.payload(s, replaceAudio)));
    s.publishTail = work;
    await work;
  }
  async open(task, valid) {
    check(
      !this.closed && this.client.isReady(),
      "Discord Botに接続してください",
      503,
    );
    check(this.sessions.size < 4, "声づくりは同時に4件までです", 429);
    const config = this.settings();
    check(
      config.enabled && config.channelId,
      "声デザイン用チャンネルを設定してください",
      409,
    );
    const s = {
      task,
      valid,
      guildId: config.guildId,
      channelId: config.channelId,
      voice: structuredClone(task.voice),
      sample: "これからこの声でお話しします。",
      version: 0,
      candidate: 0,
      busy: true,
      dirty: true,
      notice: "試聴音声を準備しています…",
      audioStatus: "⏳ 音声の生成準備中…",
      audioStarted: Date.now(),
      wav: null,
      upload: null,
    };
    this.sessions.set(task.job.id, s);
    // Attach a rejection handler immediately, even while the first post is pending.
    const result = new Promise((resolve, reject) => {
      s.resolve = resolve;
      s.reject = reject;
    });
    result.catch(() => {});
    s.abort = () => {
      s.done = true;
      s.reject(new Error("声づくりを中断しました"));
    };
    task.controller.signal.addEventListener("abort", s.abort, { once: true });
    s.timer = setTimeout(
      () => task.controller.abort(new Error("声づくりの期限が切れました")),
      this.ttl,
    );
    s.timer.unref();
    task.designFinish = async (job) => {
      s.done = true;
      clearTimeout(s.timer);
      task.controller.signal.removeEventListener("abort", s.abort);
      this.sessions.delete(task.job.id);
      s.wav = s.upload = null;
      s.notice =
        job?.status === "completed"
          ? "この声を登録しました。"
          : "声づくりを終了しました。必要ならVTTから再度登録してください。";
      try {
        await this.publish(s);
      } catch {
        this.report("声づくりの終了表示を更新できませんでした");
      }
    };
    try {
      this.validate(s);
      const channel = await this.client.channels.fetch(s.channelId);
      check(
        channel?.guildId === s.guildId && channel.type === 0,
        "専用テキストチャンネルが見つかりません",
        409,
      );
      this.validate(s);
      s.message = await channel.send(this.payload(s));
      this.validate(s);
      s.operating = true;
      try {
        s.referenceChoices = (
          await this.engine.references.list(
            task.provider,
            task.controller.signal,
          )
        ).map((v) => ({ label: v.id, value: v.id }));
      } catch {
        s.referenceChoices = [];
        this.report("参照音声一覧を取得できませんでした");
      }
      this.validate(s);
      await this.generate(s);
      s.operating = false;
      return await result;
    } catch (error) {
      s.reject(error);
      throw error;
    }
  }
  async generate(s) {
    this.validate(s);
    s.busy = true;
    s.dirty = true;
    s.published = false;
    s.version++;
    s.wav = s.upload = null;
    s.notice = "音声ができるまでお待ちください。";
    s.audioStatus = "⏳ 生成待ち…";
    s.audioStarted = Date.now();
    this.engine.store.voiceCommands.update(s.task.job.id, {
      status: "generating",
    });
    this.engine.notify("characters.changed");
    try {
      await this.publish(s, true);
      this.validate(s);
      const wav = await this.engine.preview(
        s.sample,
        structuredClone(s.voice),
        {
          registrationId: s.task.job.id,
          provider: s.task.provider,
          signal: s.task.controller.signal,
          onStart: () => {
            this.validate(s);
            s.audioStatus = "⚙️ 音声を生成中…";
            void this.publish(s).catch(() =>
              this.report("生成中の表示を更新できませんでした"),
            );
          },
        },
      );
      this.validate(s);
      check(wav.length <= AUDIO_LIMIT, "試聴音声が大きすぎます", 413);
      let upload = wav,
        format = "wav";
      if (wav.length > 8 * 1024 * 1024) {
        const Opus = await loadOpus();
        check(Opus, "音声を短くして再試行してください", 413);
        upload = encodeOggOpus(wav, Opus, 64000);
        format = "ogg";
      }
      this.validate(s);
      s.wav = wav;
      s.upload = upload;
      s.format = format;
      s.candidate++;
      s.audioStatus = null;
      s.notice = "試聴できます。";
      s.busy = false;
      s.dirty = false;
      await this.publish(s, true);
      s.published = true;
    } catch (error) {
      s.wav = s.upload = null;
      s.dirty = true;
      s.busy = false;
      s.audioStatus = "⚠️ 生成・配信に失敗しました。再試行できます。";
      s.notice =
        "生成・配信できませんでした。TTSとBotの権限を確認して再生成してください。";
      this.report(s.notice);
      this.validate(s);
      await this.publish(s, true);
    }
    this.validate(s);
    this.engine.store.voiceCommands.update(s.task.job.id, {
      status: "designing",
    });
    this.engine.notify("characters.changed");
  }
  modal(s, kind) {
    return {
      custom_id: this.id(s, `${kind}Save`),
      title: kind === "basic" ? "声の基本設定" : "声の詳細設定",
      components: (kind === "basic" ? basic : advanced).map(
        ([key, label, max_length]) =>
          row({
            type: 4,
            custom_id: key,
            label,
            style: key === "caption" ? 2 : 1,
            required: !key.startsWith("cfg") && key !== "caption",
            max_length,
            value: String(key === "sample" ? s.sample : (s.voice[key] ?? "")),
          }),
      ),
    };
  }
  edit(s, interaction, kind) {
    const voice = structuredClone(s.voice);
    let sample = s.sample;
    for (const [key] of kind === "basic" ? basic : advanced) {
      const value = interaction.fields.getTextInputValue(key).trim();
      if (key === "sample") sample = value;
      else if (key.startsWith("cfg") && !value) delete voice[key];
      else if (
        [
          "speed",
          "steps",
          "cfgScaleText",
          "cfgScaleCaption",
          "cfgScaleSpeaker",
        ].includes(key)
      ) {
        check(value !== "", "数値を入力してください");
        voice[key] = Number(value);
      } else voice[key] = value;
    }
    voiceSchema(voice);
    check(
      sample.trim() && [...sample].length <= 500 && !/[<>\u0000]/.test(sample),
      "試聴セリフが不正です",
    );
    if (hash(voice) === hash(s.voice) && sample === s.sample) return;
    s.voice = voice;
    s.sample = sample;
    this.dirty(s);
  }
  dirty(s) {
    s.version++;
    s.audioStatus = null;
    s.dirty = true;
    s.published = false;
    s.wav = s.upload = null;
    s.notice = "設定変更済み・未生成";
  }
  selectionModal(s, kind, page) {
    const list =
      kind === "voices"
        ? this.engine.config.voiceProfiles.map((v) => ({
            label: v.name,
            value: v.id,
          }))
        : (s.referenceChoices ?? []);
    const size = 23;
    check(
      Number.isInteger(page) &&
        page >= 0 &&
        page < Math.max(1, Math.ceil(list.length / size)),
      "ページが不正です",
    );
    const options = list.slice(page * size, (page + 1) * size).map((v) => ({
      label: safe(v.label).slice(0, 100) || "声",
      value: hash(v.value),
    }));
    if (page > 0)
      options.push({ label: "前の候補を見る", value: `page-${page - 1}` });
    if ((page + 1) * size < list.length)
      options.push({ label: "次の候補を見る", value: `page-${page + 1}` });
    if (!options.length)
      options.push({
        label: "候補がありません（変更せず閉じる）",
        value: "none",
      });
    return {
      custom_id: this.id(s, `${kind}Select`),
      title: `${kind === "voices" ? "既存の声" : "参照音声"}を選ぶ（${page + 1}ページ）`,
      components: [
        {
          type: 18,
          label: "声を選び、送信すると設定に反映します",
          description: "閉じる・キャンセルでは設定も試聴音声も変わりません。",
          component: {
            type: 3,
            custom_id: "choice",
            placeholder: "選んでください",
            options,
          },
        },
      ],
    };
  }
  async handle(i) {
    try {
      const [, id, version, action] = i.customId.split(":");
      // Closing a paging prompt must also work after the draft expires.
      if (action === "closePicker") {
        await i.deferUpdate();
        await i.deleteReply();
        return;
      }
      const s = this.sessions.get(id);
      check(s, "このフォームは期限切れです。VTTから再度登録してください", 409);
      this.validate(s);
      check(
        i.guildId === s.guildId && i.channelId === s.channelId && i.user?.id,
        "このチャンネルでは操作できません",
        403,
      );
      if (
        [
          "basic",
          "advanced",
          "generate",
          "confirm",
          "cancel",
          "basicSave",
          "advancedSave",
        ].includes(action)
      )
        check(
          i.message?.id === s.message?.id,
          "元の声づくりメッセージから操作してください",
          403,
        );
      check(
        String(s.version) === version && !s.done,
        "古いフォームです。元のメッセージから操作し直してください",
        409,
      );
      check(
        (!s.busy && !s.operating) || action === "cancel",
        "処理中です。完了をお待ちください",
        409,
      );
      if (action === "basic" || action === "advanced") {
        await i.showModal(this.modal(s, action));
        return;
      }
      if (/^(voices|refs)\d+$/.test(action)) {
        const [, kind, page] = /^(voices|refs)(\d+)$/.exec(action);
        await i.showModal(this.selectionModal(s, kind, Number(page)));
        return;
      }
      // Lock before the first await: simultaneous clicks must not both proceed.
      s.busy = true;
      s.operating = true;
      try {
        await i.deferReply({ flags: 64 });
        this.validate(s);
        check(String(s.version) === version, "別の操作で更新されました", 409);
        if (action === "cancel") {
          s.task.controller.abort(new Error("参加者が取り消しました"));
        } else if (action === "confirm") {
          check(
            s.wav && !s.dirty && s.published,
            "変更した設定で再生成してください",
            409,
          );
          s.task.voice = structuredClone(s.voice);
          s.notice = "この候補を登録中です…";
          await this.publish(s);
          this.validate(s);
          s.done = true;
          s.resolve(s.wav);
        } else if (action === "generate") {
          check(
            s.dirty,
            "設定は変更されていません。聴き直す場合は音声の再生ボタンを押してください",
            409,
          );
          await this.generate(s);
        } else if (["basicSave", "advancedSave"].includes(action)) {
          this.edit(s, i, action === "basicSave" ? "basic" : "advanced");
          s.busy = false;
          await this.publish(s, true);
        } else if (action === "voicesSelect" || action === "refsSelect") {
          const value = i.fields.getStringSelectValues("choice")[0];
          if (value === "none") {
            await i.deleteReply();
            return;
          }
          if (/^page-\d+$/.test(value)) {
            const kind = action === "voicesSelect" ? "voices" : "refs";
            const page = Number(value.slice(5));
            // Discord does not allow opening another modal from a modal submit.
            // A dismissible button opens the next page without changing the draft.
            this.selectionModal(s, kind, page);
            await i.editReply({
              content: "設定はまだ変わっていません。続きの候補を開けます。",
              components: [
                row(
                  button(this.id(s, `${kind}${page}`), "候補の続きを開く"),
                  button(this.id(s, "closePicker"), "閉じる"),
                ),
              ],
              allowedMentions: { parse: [] },
            });
            return;
          }
          if (action === "voicesSelect") {
            const voice = this.engine.config.voiceProfiles.find(
              (v) => hash(v.id) === value,
            );
            check(voice, "声が見つかりません");
            s.voice = { ...structuredClone(voice), id: s.task.voice.id };
          } else {
            const voices = await this.engine.references.list(
              s.task.provider,
              s.task.controller.signal,
            );
            this.validate(s);
            const selected = voices.find((v) => hash(v.id) === value);
            check(selected, "参照音声が見つかりません");
            s.voice = { ...s.voice, voiceId: selected.id };
          }
          voiceSchema(s.voice);
          this.dirty(s);
          s.busy = false;
          await this.publish(s, true);
        } else check(false, "未対応の操作です");
        await i.editReply({
          content: "受け付けました。元の声づくりメッセージをご確認ください。",
          components: [],
          allowedMentions: { parse: [] },
        });
      } finally {
        s.operating = false;
        if (!s.done) s.busy = false;
      }
    } catch (error) {
      const content = error.status
        ? error.message
        : "操作できませんでした。元のメッセージから再試行してください。";
      try {
        if (i.deferred || i.replied)
          await i.editReply({
            content,
            components: [],
            allowedMentions: { parse: [] },
          });
        else
          await i.reply({ content, flags: 64, allowedMentions: { parse: [] } });
      } catch {
        this.report("声づくりの操作結果を返信できませんでした");
      }
    }
  }
  cancel() {
    for (const s of this.sessions.values())
      s.task.controller.abort(new Error("Discord設定変更または終了"));
  }
  close() {
    this.closed = true;
    this.client.off("interactionCreate", this.listener);
    this.cancel();
  }
}
