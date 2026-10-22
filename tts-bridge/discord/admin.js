export async function mount(el, { api, setConnectionStatus = () => {} }) {
  el.innerHTML = `
    <details data-id="preparation">
      <summary>Discordの準備</summary>
      <h3>Discord Bot の準備方法</h3>
      <ol>
        <li><strong>サーバーを用意する</strong>
          <ul>
            <li>Discordに既存のサーバーを使用する場合は、この「サーバーを追加」する準備は必要ありません。</li>
            <li>Discordで「サーバーを追加」→「オリジナルの作成」を選び、サーバーを作る。
              <ul>
                <li>新しく作ったサーバーには、最初からボイスチャンネルがある。</li>
                <li>サーバーの持ち主には、Botを招待する権限（サーバー管理）がある。</li>
              </ul>
            </li>
          </ul>
        </li>
        <li><strong>Botを作る</strong>（<a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal</a>）
          <ol>
            <li>「New Application」を押し、名前を付けて作成する。名前とアイコンは後から変えられる。</li>
            <li>左のメニューの「Bot」で「Reset Token」を押し、表示されたトークンをコピーする。
              <ul>
                <li>トークンは一度しか表示されない。なくしたら、もう一度「Reset Token」で作り直す。</li>
                <li>パスワードや2段階認証の確認を求められることがある。</li>
              </ul>
            </li>
          </ol>
        </li>
        <li><strong>Botを招待する</strong>
          <ul>
            <li>「General Information」の「Application ID」を、次のURLの <code>&lt;Application ID&gt;</code> に入れて開く。
              <pre><code>https://discord.com/oauth2/authorize?client_id=&lt;Application ID&gt;&amp;scope=bot&amp;permissions=3247104</code></pre>
            </li>
            <li>開いた画面で対象のサーバーを選び、「認証」を押す。</li>
          </ul>
        </li>
      </ol>
    </details>
    <label><input data-id="enabled" type="checkbox">Discord Botに接続する</label>
    <p data-id="status" role="status"></p>
    <p data-id="error" role="alert"></p>
    <p data-id="notice" role="status"></p>
    <label>Botトークン<input data-id="token" type="password" autocomplete="new-password" maxlength="200"></label>
    <span data-id="tokenSet"></span>
    <button data-id="save">保存してログイン</button>
    <button data-id="delete">トークンを削除</button>
    <p data-id="botName"></p><button data-id="invite">招待URLをコピー</button>
    <label>ボイスチャンネル<select data-id="channel"></select></label>
    <button data-id="connect">接続</button><button data-id="disconnect">切断</button>
    <fieldset><legend>VTTチャットからDiscordで声をデザイン</legend>
    <label><input data-id="designEnabled" type="checkbox">登録コマンドで試聴フォームを開く</label>
    <label>専用テキストチャンネル<select data-id="designChannel"></select></label>
    <p>既定は従来の即時登録です。「声と読み上げの調整」設定内の「チャットによる声登録」と併用することで、Player/Chatterを使わずに、このDiscordのテキストチャンネルで声のデザインと登録を行うことができます。</p>
    <p>指定チャンネルの参加者が共同編集できます。音声と設定はチャンネル閲覧者に公開されます。本人限定ではありません。</p>
    <p>Botにはチャンネルの閲覧・送信・ファイル添付・履歴閲覧を許可してください。Developer PortalのInteractions Endpoint URLは空欄にします。</p>
    <button data-id="saveDesign">試聴モードを保存</button>
    </fieldset>
    <fieldset><legend>入室・退出メッセージ</legend>
    <label>入室メッセージ<input data-id="enter" type="text"></label>
    <label>退出メッセージ<input data-id="leave" type="text"></label>
    <p>各100文字以内。空欄なら流しません。</p>
    <label>声<select data-id="voice"></select></label>
    <p class="muted">声が未設定なら「聞き取りやすい若い女性ナレーターの声」で読み上げます。</p>
    <p data-id="greetingStatus" role="status"></p>
    <button data-id="greeting">メッセージを保存</button>
    <button data-id="previewEnter">入室を試聴</button><button data-id="previewLeave">退出を試聴</button>
    <audio data-id="preview" controls hidden></audio></fieldset>
    <p>Discordで聞く人は、Playerの音声を有効にしないでください。すでに再生中なら「音声を停止」を押してください。ログと声の設定はPlayerで使えます。</p>`;
  const $ = (id) => el.querySelector(`[data-id="${id}"]`);
  let current,
    busy = false,
    voices = [],
    previewUrl,
    initialized = false;
  const states = {
    "logged-out": "未ログイン",
    "logged-in": "ログイン済み",
    connecting: "接続中",
    connected: "接続済み",
    error: "エラー",
  };
  const channelKey = (c) => `${c.guildId}/${c.channelId}`;
  function render(s, settings = false) {
    current = s;
    const channel = s.channels.find(
      (c) => c.guildId === s.guildId && c.channelId === s.channelId,
    );
    const destination =
      channel && ["connecting", "connected"].includes(s.state)
        ? `${channel.guildName} / ${channel.channelName} — `
        : "";
    setConnectionStatus(
      !s.enabled
        ? "未使用"
        : !s.installed
          ? "未インストール"
          : `${destination}${states[s.state] ?? s.state}`,
      !s.enabled
        ? undefined
        : !s.installed || s.state === "error"
          ? "warn"
          : s.state === "connected"
            ? "ok"
            : undefined,
    );
    $("status").textContent = states[s.state] ?? s.state;
    $("error").textContent = !s.installed
      ? "cd discord && npm ci を実行してください"
      : s.error;
    $("tokenSet").textContent = s.tokenSet ? "設定済み" : "未設定";
    $("botName").textContent = s.botName;
    $("invite").disabled = !s.inviteUrl || busy;
    $("connect").disabled = !s.botName || !s.channelId || busy;
    $("disconnect").disabled = !s.botName || busy;
    if (!initialized || settings === true) {
      $("enabled").checked = s.enabled;
    }
    if (!initialized || settings === "greeting") {
      $("enter").value = s.greeting.enterText;
      $("leave").value = s.greeting.leaveText;
      selectGreetingVoice(s.greeting.voiceProfileId);
    }
    if (!initialized || settings === "design") {
      $("designEnabled").checked = s.design?.enabled ?? false;
    }
    const designSelected =
      !initialized || settings === "design"
        ? s.design?.channelId
          ? channelKey(s.design)
          : ""
        : $("designChannel").value;
    const designOptions = [new Option("チャンネルを選んでください", "")];
    for (const c of s.textChannels ?? []) {
      const option = new Option(
        `${c.guildName} / ${c.channelName}${c.canSend ? "" : "（権限がありません）"}`,
        channelKey(c),
      );
      option.disabled = !c.canSend;
      designOptions.push(option);
    }
    if (
      designSelected &&
      !designOptions.some((o) => o.value === designSelected)
    )
      designOptions.push(
        new Option("保存済みのチャンネル（未取得）", designSelected),
      );
    $("designChannel").replaceChildren(...designOptions);
    $("designChannel").value = designSelected;
    renderGreetingStatus();
    const selected = channelKey(s);
    const options = [new Option("チャンネルを選んでください", "")];
    for (const c of s.channels) {
      const option = new Option(
        `${c.guildName} / ${c.channelName}${c.canSpeak ? "" : "（権限がありません）"}`,
        channelKey(c),
      );
      option.disabled = !c.canSpeak;
      options.push(option);
    }
    if (s.channelId && !s.channels.some((c) => channelKey(c) === selected)) {
      const option = new Option("保存済みのチャンネル（未取得）", selected);
      option.disabled = true;
      options.push(option);
    }
    $("channel").replaceChildren(...options);
    $("channel").value = s.channelId ? selected : "";
    initialized = true;
  }
  function greetingDraft() {
    return {
      enterText: $("enter").value,
      leaveText: $("leave").value,
      voiceProfileId: $("voice").value,
    };
  }
  function renderGreetingStatus() {
    if (!current) return;
    const draft = greetingDraft();
    if (
      Object.keys(draft).some((key) => draft[key] !== current.greeting[key])
    ) {
      $("greetingStatus").textContent =
        "変更は未保存です。「メッセージを保存」を押してください。";
      return;
    }
    const labels = {
      disabled: "流しません",
      "voice-missing":
        "保存した声が削除されています。選び直して保存してください",
      generating: "音声を生成中です",
      ready: "音声の準備済み",
      pending: "保存または接続すると音声を生成します",
      error: "音声の生成に失敗しました",
    };
    $("greetingStatus").textContent = [
      ["入室", current.greetingAudio?.enter],
      ["退出", current.greetingAudio?.leave],
    ]
      .map(
        ([name, audio]) =>
          `${name}: ${labels[audio?.state] ?? "準備状態を確認しています"}${audio?.error ? `（${audio.error}）` : ""}`,
      )
      .join(" ／ ");
  }
  for (const id of ["enter", "leave", "voice"])
    $(id).addEventListener("input", renderGreetingStatus);
  function selectGreetingVoice(id) {
    if (id && !voices.some((voice) => voice.id === id)) {
      const option = new Option("保存した声（見つかりません）", id);
      option.disabled = true;
      if (![...$("voice").options].some((option) => option.value === id))
        $("voice").append(option);
    }
    $("voice").value = id;
  }
  async function refreshVoices() {
    const r = await fetch("/api/v1/admin/config");
    if (!r.ok) throw new Error("声の一覧を取得できません");
    voices = (await r.json()).voiceProfiles;
    const selected = initialized
      ? $("voice").value
      : (current?.greeting.voiceProfileId ?? "");
    $("voice").replaceChildren(
      new Option("未設定（標準のナレーター音声）", ""),
      ...voices.map((v) => new Option(v.name, v.id)),
    );
    selectGreetingVoice(selected);
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    $("notice").textContent = "処理しています…";
    el.querySelectorAll("button, input, select").forEach(
      (control) => (control.disabled = true),
    );
    try {
      await fn();
      $("notice").textContent = "完了しました";
    } catch (e) {
      $("notice").textContent = e.message;
    } finally {
      busy = false;
      el.querySelectorAll("button, input, select").forEach(
        (control) => (control.disabled = false),
      );
      try {
        const saved = await api("status");
        if ($("enabled").checked !== saved.enabled) {
          $("enabled").checked = saved.enabled;
        }
        render(saved);
      } catch {
        /* preserve action error */
      }
    }
  }
  $("enabled").onchange = () => {
    const enabled = $("enabled").checked;
    void run(async () =>
      render(await api("settings", "PUT", { enabled }), true),
    );
  };
  $("save").onclick = () =>
    run(async () => {
      const token = $("token").value;
      // Clear immediately, including on errors; the API never echoes the token.
      $("token").value = "";
      render(
        await api("settings", "PUT", {
          enabled: $("enabled").checked,
          ...(token ? { token } : {}),
        }),
        true,
      );
    });
  $("delete").onclick = () => {
    if (confirm("トークンを削除してBotをログアウトしますか？"))
      void run(async () => {
        $("token").value = "";
        render(await api("token", "DELETE"), true);
      });
  };
  $("channel").onchange = () => {
    const selected = current.channels.find(
      (c) => channelKey(c) === $("channel").value,
    );
    if (selected)
      void run(async () =>
        render(
          await api("settings", "PUT", {
            channel: {
              guildId: selected.guildId,
              channelId: selected.channelId,
            },
          }),
        ),
      );
  };
  for (const action of ["connect", "disconnect"])
    $(action).onclick = () =>
      run(async () => render(await api(action, "POST", {})));
  $("invite").onclick = () =>
    run(async () => {
      try {
        await navigator.clipboard.writeText(current.inviteUrl);
      } catch {
        throw new Error(`招待URL: ${current.inviteUrl}`);
      }
    });
  $("greeting").onclick = () =>
    run(async () =>
      render(
        await api("greeting", "PUT", {
          ...greetingDraft(),
        }),
        "greeting",
      ),
    );
  $("saveDesign").onclick = () =>
    run(async () => {
      const [guildId, channelId] = $("designChannel").value.split("/");
      render(
        await api("design", "PUT", {
          enabled: $("designEnabled").checked,
          guildId,
          channelId,
        }),
        "design",
      );
    });
  for (const [button, text] of [
    ["previewEnter", "enter"],
    ["previewLeave", "leave"],
  ]) {
    $(button).onclick = () =>
      run(async () => {
        const selected = $("voice").value;
        const voice = selected
          ? voices.find((v) => v.id === selected)
          : current.defaultGreetingVoice;
        if (!voice)
          throw new Error(
            "保存した声が見つかりません。選び直して保存してください",
          );
        const r = await fetch("/api/v1/admin/previews", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ text: $(text).value, voice }),
        });
        if (!r.ok) throw new Error((await r.json()).error);
        $("preview").pause();
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(await r.blob());
        $("preview").src = previewUrl;
        $("preview").hidden = false;
        await $("preview").play();
      });
  }
  await refreshVoices();
  render(await api("status"), true);
  let polling = false;
  const timer = setInterval(async () => {
    if (!el.isConnected) {
      clearInterval(timer);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      return;
    }
    if (busy || polling || document.hidden) return;
    polling = true;
    try {
      await refreshVoices();
      render(await api("status"));
    } catch (e) {
      $("error").textContent = e.message;
      setConnectionStatus("状態を取得できません", "warn");
    } finally {
      polling = false;
    }
  }, 5000);
}
