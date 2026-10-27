let modelState,
  modelTimer,
  modelRequest,
  trackedPull,
  modelsOpened = false,
  modelBusy = false,
  modelGeneration = 0;
const pulling = (job) =>
  ["starting", "running", "stopping"].includes(job?.status);
const catalogs = [
  {
    task: "synthesis",
    prefix: "catalog",
    field: "runtimeModel",
    initial: "irodori-tts:q8_0",
  },
  {
    task: "recognition",
    prefix: "sttCatalog",
    field: "sttModel",
    initial: "qwen3-asr-0.6b:q8_0",
  },
];
const modelTask = (model) => model?.task ?? "synthesis";
const gb = (bytes) => (bytes / 1e9).toFixed(2);
const $ = (id) => document.getElementById(id);
let stepsInitialized = false,
  previousPending = 0,
  refreshTimer,
  shuttingDown = false,
  canRestart = false,
  startup;
// The startup settings keep their fixed 0, so the other steps keep the
// numbers the guides refer to.
function numberSteps() {
  document
    .querySelectorAll("details.step:not([hidden]):not(#stepStartup) .step-num")
    .forEach((el, i) => {
      el.textContent = i + 1;
    });
}
function setState(el, text, kind = "") {
  el.textContent = text;
  el.className = `state ${kind}`;
}
numberSteps();
let runtimeInitialized = false,
  runtimeState;
let accepting = false,
  provider,
  chatVoiceRegistrationEnabled = false,
  deliveryCaptionMode,
  publishText,
  sentencePauseMs,
  sentenceSplitThresholdChars,
  audioFormat;
async function api(path, method = "GET", body) {
  const r = await fetch(`/api/v1/admin/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
const command = (command, extra = {}) =>
  api("commands", "POST", {
    command,
    commandId: crypto.randomUUID(),
    ...extra,
  });
async function run(fn) {
  try {
    $("notice").textContent = "";
    await fn();
  } catch (e) {
    if (!shuttingDown) $("notice").textContent = e.message;
  }
}
// A menu value is "external" or "bundled:<backend>". The Bridge lists the
// builds its own platform carries: Windows has Vulkan and CPU, macOS one.
function runtimeLabel(mode, backend, backends) {
  if (mode === "external") return "外部サーバー";
  const names = { vulkan: "Vulkan", cpu: "CPU" };
  return backends.length > 1
    ? `内蔵speech.cpp（${names[backend] ?? backend}）`
    : "内蔵speech.cpp";
}
// The menu picks the next start's mode; the active mode decides the connection.
function applyRuntimeView() {
  if (!runtimeState) return;
  const bundled = runtimeState.active.mode === "bundled";
  const selected = $("runtimeMode").value.startsWith("bundled");
  $("bundledFields").hidden = !selected;
  $("providerSection").hidden = selected;
  $("providerUrl").disabled = bundled;
  $("providerType").disabled = bundled;
  $("providerForm").querySelector("button").disabled = bundled;
  $("providerNote").hidden = !bundled;
}
async function refresh() {
  if (shuttingDown) return;
  const [d, pending] = await Promise.all([api("diagnostics"), api("pairings")]);
  if (shuttingDown) return;
  const referenceProgress = d.referenceProgress ?? d.runtime?.referenceProgress;
  const restoringReferences =
    referenceProgress?.state === "running" && referenceProgress.total > 0;
  const referenceStatus = restoringReferences
    ? `参照音声復元中 ${referenceProgress.completed}/${referenceProgress.total} 件${referenceProgress.failed ? `（${referenceProgress.failed}件は要確認）` : ""}`
    : "";
  $("referenceProgress").hidden = !restoringReferences;
  $("referenceProgress").textContent = referenceStatus;
  const ttsConnected = ![
    "unreachable",
    "error",
    "starting",
    "stopped",
  ].includes(d.tts.status);
  const collectorConnected = d.collectors.some((c) => c.online);
  if (!stepsInitialized) {
    $("stepTts").open = !ttsConnected;
    $("stepCollector").open = !!pending.length;
    $("stepSession").open = true;
    $("stepEnd").open = true;
    stepsInitialized = true;
  } else if (!previousPending && pending.length) {
    $("stepCollector").open = true;
  }
  previousPending = pending.length;
  setState(
    $("ttsState"),
    ttsConnected ? "接続済み" : "未接続・準備中",
    ttsConnected ? "ok" : "warn",
  );
  setState(
    $("collectorState"),
    pending.length
      ? "承認待ち"
      : collectorConnected
        ? "接続中"
        : "任意・未接続",
    pending.length ? "warn" : collectorConnected ? "ok" : "",
  );
  setState(
    $("sessionState"),
    `読み上げ${d.accepting ? "中" : "停止中"} ／ 参加者 ${d.players.length} 接続`,
    d.accepting ? "ok" : "",
  );
  canRestart = Boolean(d.canRestart);
  $("restartNotice").hidden = !(
    d.runtime?.restartRequired &&
    (d.canRestart || d.canShutdown)
  );
  $("restartNoticeRestart").hidden = !d.canRestart;
  $("runtimeRestart").hidden = !d.canRestart;
  $("restartNoticeShutdown").hidden = !!d.canRestart;
  $("restartNotice").querySelector("[data-shutdown]").hidden = !!d.canRestart;
  $("shutdownSection").hidden = !d.canShutdown;
  $("shutdownNote").hidden = !d.runtime || !d.canShutdown;
  if (d.runtime) {
    $("runtimeSection").hidden = false;
    const r = (runtimeState = d.runtime);
    const target =
      r.active.mode === "bundled"
        ? `http://127.0.0.1:${r.active.ttsPort}`
        : (provider?.baseUrl ?? "");
    const states = {
      external: "外部サーバー",
      stopped: "停止",
      starting: referenceStatus || "モデル読込中",
      ready: "準備完了",
      error: "起動失敗",
    };
    if (r.active.mode === "bundled")
      setState(
        $("ttsState"),
        states[r.status] ?? r.status,
        r.status === "ready" ? "ok" : r.status === "error" ? "warn" : "",
      );
    const parts =
      r.active.mode === "bundled"
        ? [
            states[r.status] ?? r.status,
            runtimeLabel("bundled", r.active.backend, r.backends),
            r.active.model || "モデル指定なし",
            `ポート ${r.active.ttsPort}`,
          ]
        : [states.external];
    $("runtimeStatus").textContent =
      `現在: ${[...parts, `接続先 ${target}`].join(" / ")}${r.error ? " — " + r.error : ""}${r.restartRequired ? "（保存済み設定の反映には再起動が必要です）" : ""}`;
    if (r.stt?.enabled) {
      const sttStates = {
        ready: "準備完了",
        starting: "準備中",
        stopped: "停止",
        error: "エラー",
        disabled: "無効",
      };
      $("runtimeStatus").textContent +=
        `\n文字起こし：${r.stt.error || sttStates[r.stt.status] || r.stt.status}`;
      if (r.transcription?.path)
        $("runtimeStatus").textContent +=
          `\n書き出し先：${r.transcription.path}`;
      if (r.transcription?.error)
        $("runtimeStatus").textContent +=
          `\n文字起こしのファイルを書き出せません：${r.transcription.error}`;
      if (r.status === "error")
        $("runtimeStatus").textContent +=
          "\nSTTモデルを読み込めない場合は、文字起こしを無効にして設定を保存し、Bridgeを再起動してください。";
    }
    if (!runtimeInitialized) {
      for (const backend of r.backends) {
        const option = document.createElement("option");
        option.value = `bundled:${backend}`;
        option.textContent = runtimeLabel("bundled", backend, r.backends);
        $("runtimeMode").append(option);
      }
      $("runtimeMode").value =
        r.saved.mode === "bundled" ? `bundled:${r.saved.backend}` : "external";
      $("runtimeModel").value = r.saved.model;
      $("runtimePort").value = r.saved.ttsPort;
      $("sttEnabled").checked = r.saved.stt?.enabled ?? false;
      $("sttModel").value = r.saved.stt?.model ?? "";
      $("sttLogDir").value = r.saved.stt?.logDir ?? "";
      runtimeInitialized = true;
      void refreshModels(true);
    }
    applyRuntimeView();
  }
  if (restoringReferences) setState($("ttsState"), referenceStatus);
  const registrations = (d.voiceCommands ?? [])
    .filter((x) => x.status === "failed")
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .slice(0, 5);
  $("voiceCommandDiagnostics").replaceChildren(
    ...registrations.map((x) => {
      const item = document.createElement("p");
      item.textContent = `${x.kind === "delete" ? "声削除" : "声登録"}: ${x.characterId ?? "キャラ不明"} — ${x.reason ?? ""}${x.detail ? ` / ${x.detail}` : ""}${x.referenceId ? ` / 参照音声ID（上流に残っている可能性があります）: ${x.referenceId}` : ""}`;
      return item;
    }),
  );
  accepting = d.accepting;
  $("toggle").textContent = accepting ? "読み上げ停止" : "読み上げ開始";
  $("toggle").disabled = false;
  $("connection").textContent =
    `Irodori-TTS: ${["unreachable", "error", "starting", "stopped"].includes(d.tts.status) ? "未接続・準備中" : "接続済み"}${referenceStatus ? ` ／ ${referenceStatus}` : ""} ／ 読み上げ${accepting ? "中" : "停止中"}`;
  const collectors = d.collectors.length
    ? d.collectors.map(
        (c) =>
          `${c.source.adapter} / ${c.source.contextId}: ${c.online ? "接続中" : "切断"} — ${c.diagnostic}`,
      )
    : ["未接続（VTTのタブで拡張機能を開いて接続してください）"];
  $("collectors").replaceChildren(
    ...collectors.map((text) => {
      const line = document.createElement("div");
      line.textContent = text;
      return line;
    }),
  );
  $("participants").textContent = `参加者 ${d.players.length} 接続`;
  $("recovery").hidden = !d.degraded && !d.lastError;
  $("recover").hidden = !d.degraded;
  $("failure").textContent = d.lastError ?? "";
  const referenceIssues = d.referenceVoices ?? [];
  $("referenceRecovery").hidden = !referenceIssues.length;
  $("referenceIssues").replaceChildren(
    ...referenceIssues.map((issue) => {
      const row = document.createElement("p"),
        label = document.createElement("span");
      label.textContent = `${issue.id ? `${issue.id}: ` : ""}${issue.message}`;
      row.append(label);
      if (issue.kind === "conflict") {
        const button = document.createElement("button");
        button.textContent = "同じ音声と確認して紐付け";
        button.onclick = () => {
          if (
            !confirm(
              `接続先の「${issue.id}」が保存した参照音声と同じだと確認しましたか？\n音声データの一致は自動検証できません。確認した場合のみ紐付けてください。`,
            )
          )
            return;
          run(async () => {
            await api("reference-voices/resolve", "POST", {
              action: "adopt",
              id: issue.id,
              sha256: issue.sha256,
              before: d.referenceProvider,
              confirm: true,
            });
            await refresh();
          });
        };
        row.append(button);
      }
      if (issue.sha256) {
        const button = document.createElement("button");
        button.textContent = "管理対象から外す";
        button.onclick = () => {
          if (
            !confirm(
              `「${issue.id}」をBridgeの管理対象から外しますか？\nすべての接続先との登録記録を外し、残っているWAVは保存先のvoices-detachedフォルダーへ退避します。TTS側の音声やキャラの声設定は削除しません。同名音声がTTS側に残る間は、同じIDで新規登録できません。`,
            )
          )
            return;
          run(async () => {
            await api("reference-voices/resolve", "POST", {
              action: "forget",
              id: issue.id,
              sha256: issue.sha256,
              before: d.referenceProvider,
              confirm: true,
            });
            await refresh();
          });
        };
        row.append(button);
      }
      return row;
    }),
  );
  $("retryReferences").onclick = () =>
    run(async () => {
      await api("reference-voices/resolve", "POST", {
        action: "retry",
        before: d.referenceProvider,
      });
      await refresh();
    });
  $("pairingSection").hidden = !pending.length;
  $("pairings").replaceChildren();
  for (const p of pending) {
    const row = document.createElement("div"),
      label = document.createElement("strong");
    label.textContent = p.code;
    row.append(label);
    for (const [name, approve] of [
      ["承認", true],
      ["拒否", false],
    ]) {
      const button = document.createElement("button");
      button.textContent = name;
      button.onclick = () =>
        run(async () => {
          await api("pairings", "POST", { id: p.id, approve });
          await refresh();
        });
      row.append(button);
    }
    $("pairings").append(row);
  }
}
$("toggle").onclick = () =>
  run(async () => {
    await command(accepting ? "stop" : "start");
    await refresh();
  });
$("copyExtensionsUrl").onclick = () =>
  run(async () => {
    try {
      await navigator.clipboard.writeText("chrome://extensions");
      $("notice").textContent =
        "chrome://extensions をコピーしました。新しいタブのアドレスバーに貼り付けて開いてください。";
    } catch {
      $("notice").textContent = "表示されたアドレスをコピーしてください。";
    }
  });
$("copyInvite").onclick = () =>
  run(async () => {
    const invite = await command("invite");
    $("invite").textContent = invite.url;
    try {
      await navigator.clipboard.writeText(invite.url);
      $("notice").textContent = "参加URLをコピーしました。";
    } catch {
      $("notice").textContent = "表示された参加URLをコピーしてください。";
    }
  });
$("openPlayer").onclick = () => {
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  run(async () => {
    const invite = await command("invite");
    if (tab) tab.location = invite.localUrl;
    else location.href = invite.localUrl;
  });
};
$("providerForm").onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    provider = await api("provider", "PUT", {
      before: provider,
      baseUrl: $("providerUrl").value,
      type: $("providerType").value,
    });
    $("notice").textContent = "接続先を保存しました。";
    await refresh();
  });
};
$("publishText").onchange = () =>
  run(async () => {
    const wanted = $("publishText").checked;
    try {
      publishText = (
        await api("subtitles", "PUT", {
          before: publishText,
          publishTextToPlayers: wanted,
        })
      ).publishTextToPlayers;
      $("notice").textContent = publishText
        ? "チャットと本文を共有します。"
        : "チャットと本文の共有を停止しました。保存済み履歴は保持されます。";
    } finally {
      $("publishText").checked = publishText;
    }
  });
$("clearChatHistory").onclick = () =>
  run(async () => {
    if (
      !confirm(
        "卓全体のチャット履歴を消去します。参加者の表示にも反映されます。音声は停止・削除されません。続行しますか？",
      )
    )
      return;
    await api("chat-history", "DELETE");
    $("notice").textContent = "卓のチャット履歴を消去しました。";
  });
$("chatVoiceRegistration").onchange = () =>
  run(async () => {
    const wanted = $("chatVoiceRegistration").checked;
    $("chatVoiceRegistration").disabled = true;
    try {
      chatVoiceRegistrationEnabled = (
        await api("chat-voice-registration", "PUT", {
          before: chatVoiceRegistrationEnabled,
          chatVoiceRegistrationEnabled: wanted,
        })
      ).chatVoiceRegistrationEnabled;
      $("notice").textContent = "チャットによる登録機能の設定を保存しました。";
    } finally {
      $("chatVoiceRegistration").checked = chatVoiceRegistrationEnabled;
      $("chatVoiceRegistration").disabled = false;
    }
  });
$("deliveryCaptionMode").onchange = () =>
  run(async () => {
    const wanted = $("deliveryCaptionMode").value;
    $("deliveryCaptionMode").disabled = true;
    try {
      deliveryCaptionMode = (
        await api("delivery", "PUT", {
          before: deliveryCaptionMode,
          deliveryCaptionMode: wanted,
        })
      ).deliveryCaptionMode;
      $("notice").textContent = "感情・演技の指定方法を保存しました。";
    } finally {
      $("deliveryCaptionMode").value = deliveryCaptionMode;
      $("deliveryCaptionMode").disabled = false;
    }
  });
$("sentenceSplitThreshold").onchange = () =>
  run(async () => {
    const wanted = Number($("sentenceSplitThreshold").value);
    try {
      if (!Number.isInteger(wanted) || wanted < 1 || wanted > 500)
        throw new Error("文の分割しきい値は1～500文字で指定してください");
      sentenceSplitThresholdChars = (
        await api("splitting", "PUT", {
          before: sentenceSplitThresholdChars,
          sentenceSplitThresholdChars: wanted,
        })
      ).sentenceSplitThresholdChars;
      $("notice").textContent =
        `本文が${sentenceSplitThresholdChars}文字を超えるセリフだけ分割します。`;
    } finally {
      $("sentenceSplitThreshold").value = sentenceSplitThresholdChars;
    }
  });
$("audioFormat").onchange = () =>
  run(async () => {
    const wanted = $("audioFormat").value;
    $("audioFormat").disabled = true;
    try {
      audioFormat = (
        await api("audio-format", "PUT", {
          before: audioFormat,
          audioFormat: wanted,
        })
      ).audioFormat;
      $("notice").textContent = "音声の配信形式を保存しました。";
    } finally {
      $("audioFormat").value = audioFormat;
      $("audioFormat").disabled = false;
    }
  });
$("sentencePause").onchange = () =>
  run(async () => {
    const wanted = Math.round(Number($("sentencePause").value) * 1000);
    try {
      if (!Number.isFinite(wanted) || wanted < 0 || wanted > 3000)
        throw new Error("文と文の間は0～3秒で指定してください");
      sentencePauseMs = (
        await api("playback", "PUT", {
          before: sentencePauseMs,
          sentencePauseMs: wanted,
        })
      ).sentencePauseMs;
      $("notice").textContent =
        `文と文の間を${sentencePauseMs / 1000}秒にしました。`;
    } finally {
      $("sentencePause").value = sentencePauseMs / 1000;
    }
  });
$("testConnection").onclick = () =>
  run(async () => {
    await refresh();
    $("notice").textContent = $("connection").textContent;
  });
$("recover").onclick = () =>
  run(async () => {
    await command("recover-provider");
    await refresh();
  });
for (const [id, cmd, message] of [
  [
    "renewInvite",
    "renew-invite",
    "新しい参加URLを発行します。以前のURLでは新規参加できなくなります。",
  ],
  [
    "endSession",
    "end",
    "セッションを終了し、参加者とCollectorの接続を閉じます。",
  ],
  [
    "revokeCollectors",
    "revoke-collectors",
    "Collectorの承認を取り消します。次の接続には承認が必要です。",
  ],
  [
    "resetSettings",
    "reset-settings",
    "キャラ・声・紐付けをconfigの初期値へ戻し、読み上げを停止します。認証情報と接続設定は残ります。続行しますか？",
  ],
])
  $(id).onclick = () =>
    run(async () => {
      if (!confirm(message)) return;
      const result = await command(cmd, { confirm: true });
      $("invite").textContent = result.url ?? "";
      $("notice").textContent = "実行しました。";
      await refresh();
    });
$("releaseCollector").onclick = () =>
  run(async () => {
    await command("release-collector");
    await refresh();
  });
const startupFields = {
  dataDir: "startupDataDir",
  host: "startupHost",
  port: "startupPort",
  publicOrigin: "startupPublicOrigin",
};
const lockNote = (name) =>
  `${name.startsWith("--") ? `起動オプション ${name}` : `環境変数 ${name}`}で指定中のため、ここでは変更できません。`;
function renderStartup() {
  const { saved, active, defaults, locks, file, lastRestart } = startup;
  const shown = saved ?? { ...defaults, dataDir: "" };
  for (const [field, id] of Object.entries(startupFields)) {
    const value = locks[field] ? active[field] : shown[field];
    if (field === "host" && ![...$(id).options].some((o) => o.value === value))
      $(id).append(new Option(value, value));
    $(id).value = value;
    $(id).disabled = Boolean(locks[field]);
  }
  $("startupDataDir").placeholder = defaults.dataDir;
  const notes = {
    dataDir: `空欄なら既定の保存先（${defaults.dataDir}）を使います。`,
    host: "ほかのPCの参加者がPlayer・Chatterを使うときは、0.0.0.0にして公開Originも指定します。",
    port: `既定は${defaults.port}です。変えたときは、Collectorの「Bridge URL」も変えてください。`,
    publicOrigin:
      "参加者がブラウザで開くURLの http://アドレス:ポート の部分です。空欄なら公開しません。",
  };
  for (const [field, id] of Object.entries(startupFields))
    $(`${id}Note`).textContent = locks[field]
      ? lockNote(locks[field])
      : notes[field];
  $("startupFile").textContent = `設定ファイル: ${file}`;
  $("startupError").textContent = lastRestart?.error ?? "";
  $("startupError").hidden = !lastRestart;
  setState(
    $("startupState"),
    `${active.host}:${active.port}`,
    lastRestart ? "warn" : "",
  );
}
// The fields a request sends; locked ones stay out.
function startupInput(values) {
  return Object.fromEntries(
    Object.keys(startupFields)
      .filter((field) => !startup.locks[field])
      .map((field) => [field, values(field)]),
  );
}
function restartWarnings(input) {
  const { active, defaults } = startup;
  const lines = [
    "参加者・Collector・Chatterの接続が切れます。参加URLを再発行して渡し直し、Collectorは拡張から接続し直してください。",
  ];
  if (
    "dataDir" in input &&
    (input.dataDir || defaults.dataDir) !== active.dataDir
  )
    lines.push(
      "保存先を変えると、その保存先のキャラ・声・Collectorの承認・Discordの設定に切り替わります。今の保存先のデータは移動も削除もしません。",
    );
  if ("port" in input && input.port !== active.port)
    lines.push(
      "ポートを変えると、管理画面とPlayerのURLが変わります。Collectorの「Bridge URL」も変えてください。",
    );
  return lines.map((line) => `・${line}`).join("\n");
}
// The page asks its own origin for the result; after a port change the old
// address answers until the admin page moves to the new one.
async function restartBridge(request) {
  const { restartId } = await request();
  shuttingDown = true;
  clearInterval(refreshTimer);
  clearTimeout(modelTimer);
  for (const el of document.querySelectorAll(
    "main button, main input, main select",
  ))
    el.disabled = true;
  $("notice").textContent = "Bridgeを再起動しています…";
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    let result;
    try {
      const r = await fetch("/api/v1/restart-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: restartId }),
      });
      if (!r.ok) continue;
      result = await r.json();
    } catch {
      continue;
    }
    if (result.state === "restarting") continue;
    const target = new URL(result.adminUrl);
    target.hash += "&restarted=1";
    if (
      target.origin === location.origin &&
      target.pathname === location.pathname
    ) {
      history.replaceState(null, "", target.href);
      location.reload();
    } else location.replace(target.href);
    return;
  }
  $("notice").textContent =
    "再起動を確認できませんでした。Bridgeを起動した端末の表示を確認してください。";
}
async function mountStartup(restarted) {
  startup = await api("startup");
  $("stepTts").before($("startupTemplate").content.cloneNode(true));
  renderStartup();
  const dataDir = startup.active.dataDir;
  const separator = dataDir.includes("\\") ? "\\" : "/";
  $("sttLogDirDefault").textContent =
    `既定: ${dataDir.replace(/[\\/]$/, "")}${separator}transcripts`;
  $("stepStartup").open = Boolean(restarted && startup.lastRestart);
  $("startupForm").onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      const input = startupInput((field) =>
        field === "port"
          ? Number($(startupFields[field]).value)
          : $(startupFields[field]).value.trim(),
      );
      if (
        !confirm(
          `起動設定を保存し、Bridgeを再起動します。\n${restartWarnings(input)}`,
        )
      )
        return;
      await restartBridge(() => api("startup", "PUT", input));
    });
  };
  $("startupReset").onclick = () =>
    run(async () => {
      const input = startupInput((field) =>
        field === "dataDir" ? "" : startup.defaults[field],
      );
      if (
        !confirm(
          `起動設定を既定値に戻し、Bridgeを再起動します。保存先の中のデータは削除しません。\n${restartWarnings(input)}`,
        )
      )
        return;
      await restartBridge(() => api("startup", "DELETE"));
    });
}
$("runtimeRestart").onclick = () =>
  run(async () => {
    if (
      !confirm(
        `Bridgeを再起動して、TTSの起動設定を反映します。\n${restartWarnings({})}`,
      )
    )
      return;
    await restartBridge(() => api("restart", "POST", {}));
  });
await run(async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const access = params.get("access"),
    restarted = params.has("restarted");
  history.replaceState(null, "", location.pathname);
  if (access) {
    const r = await fetch("/api/v1/admin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
  }
  const config = await api("config");
  provider = config.provider;
  chatVoiceRegistrationEnabled = config.chatVoiceRegistrationEnabled ?? false;
  $("chatVoiceRegistration").checked = chatVoiceRegistrationEnabled;
  deliveryCaptionMode = config.deliveryCaptionMode ?? "append";
  publishText = config.publishTextToPlayers;
  sentencePauseMs = config.sentencePauseMs ?? 900;
  sentenceSplitThresholdChars = config.sentenceSplitThresholdChars ?? 150;
  audioFormat = config.audioFormat ?? "opus64";
  $("audioFormat").value = audioFormat;
  $("providerUrl").value = provider.baseUrl;
  $("providerType").value = provider.type;
  $("deliveryCaptionMode").value = deliveryCaptionMode;
  $("publishText").checked = publishText;
  $("sentencePause").value = sentencePauseMs / 1000;
  $("sentenceSplitThreshold").value = sentenceSplitThresholdChars;
  await refresh();
  if (canRestart) {
    await mountStartup(restarted);
    if (restarted)
      $("notice").textContent =
        startup.lastRestart?.error ?? "Bridgeを再起動しました。";
  }
  refreshTimer = setInterval(() => {
    if (!shuttingDown) void run(refresh);
  }, 5000);
  let previousRow = $("connection").closest("tr");
  for (const extension of await api("extensions")) {
    const row = document.createElement("tr"),
      label = document.createElement("th"),
      connectionStatus = document.createElement("td");
    label.scope = "row";
    label.textContent = extension.title;
    connectionStatus.textContent = "確認しています…";
    row.append(label, connectionStatus);
    previousRow.after(row);
    previousRow = row;
    const step = document.createElement("details");
    step.className = "step";
    step.innerHTML =
      '<summary><span class="step-num"></span><span class="step-title"></span><small>使う場合</small><span class="state"></span></summary><div class="step-body"></div>';
    step.querySelector(".step-title").textContent = extension.title;
    const state = step.querySelector(".state");
    setState(state, "確認しています…");
    const container = step.querySelector(".step-body");
    $("extensions").append(step);
    numberSteps();
    try {
      const { mount } = await import(extension.script);
      await mount(container, {
        setConnectionStatus: (text, kind) => {
          connectionStatus.textContent = text;
          setState(state, text, kind);
        },
        api: (path, method, body) =>
          api(`ext/${extension.id}/${path}`, method, body),
      });
    } catch {
      connectionStatus.textContent = "読み込めませんでした";
      setState(state, "読み込めませんでした", "warn");
      container.textContent = `${extension.title}: 読み込めませんでした`;
    }
  }
});

$("runtimeMode").onchange = () => {
  applyRuntimeView();
  void refreshModels(true);
};
$("runtimeForm").onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    // The external mode keeps the last bundled build for a later switch back.
    const [mode, backend = runtimeState.saved.backend] =
      $("runtimeMode").value.split(":");
    const stt = {
      enabled: mode === "bundled" && $("sttEnabled").checked,
      model: $("sttModel").value.trim(),
      logDir: $("sttLogDir").value.trim(),
    };
    const absolutePath = (path) =>
      /^(?:\/|[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(path) &&
      !path.includes("\0");
    if (stt.enabled && !stt.model)
      throw new Error("STTモデルを指定してください");
    if (stt.model && (!absolutePath(stt.model) || !/\.gguf$/i.test(stt.model)))
      throw new Error("STTモデルは.ggufで終わる絶対パスを指定してください");
    if (stt.logDir && !absolutePath(stt.logDir))
      throw new Error("文字起こしの書き出し先は絶対パスを指定してください");
    await api("runtime", "PUT", {
      mode,
      stt,
      backend,
      model: $("runtimeModel").value.trim(),
      ttsPort: Number($("runtimePort").value),
    });
    await refresh();
  });
};
for (const button of document.querySelectorAll("[data-shutdown]"))
  button.onclick = () =>
    run(async () => {
      await api("shutdown", "POST", {});
      shuttingDown = true;
      clearInterval(refreshTimer);
      clearTimeout(modelTimer);
      document.querySelectorAll("[data-shutdown]").forEach((el) => {
        el.disabled = true;
      });
      $("notice").textContent =
        "Bridgeを終了しています。この画面を閉じてからBridgeを起動し直してください。";
    });

$("sttLogDirReset").onclick = () => {
  $("sttLogDir").value = "";
};
function modelStatus(message, error = false, catalog = catalogs[0]) {
  const el = $(`${catalog.prefix}Status`);
  el.textContent = message;
  el.className = error ? "error" : "muted";
  el.hidden = !message;
}
function renderModels() {
  if (!modelState) {
    for (const id of ["modelDir", "modelDirSave", "modelDirReset"])
      $(id).disabled = modelBusy;
    return;
  }
  const { models, pull, dir, defaultDir } = modelState;
  const busy = modelBusy || pulling(pull);
  for (const catalog of catalogs) {
    const { prefix, task, initial } = catalog;
    const node = (name) => $(`${prefix}${name}`);
    const choices = models.filter((m) => modelTask(m) === task);
    const ownPull =
      pulling(pull) && choices.some((m) => m.choice === pull.choice);
    const otherPull = pulling(pull) && !ownPull;
    const selected = ownPull ? pull.choice : node("Model").value || initial;
    node("Model").replaceChildren(
      ...choices.map((m) => {
        const suffix = m.fetched
          ? "・取得済み"
          : ownPull && pull.choice === m.choice
            ? "・ダウンロード中"
            : m.partial
              ? `・途中 ${Math.floor((m.partial / m.size) * 100)}%`
              : "";
        return new Option(`${m.label}（${gb(m.size)}GB）${suffix}`, m.choice);
      }),
    );
    const m = choices.find((m) => m.choice === selected) ?? choices[0];
    if (m) node("Model").value = m.choice;
    node("Model").disabled = busy;
    if (task === "synthesis") $("catalogLicense").hidden = !m?.gemma;
    node("Use").disabled = busy || !m;
    node("Use").textContent = otherPull
      ? "別のモデルをダウンロード中です"
      : ownPull
        ? "ダウンロード中…"
        : !m
          ? "利用できるモデルがありません"
          : m.fetched
            ? "このモデルを使う"
            : m.partial
              ? "続きからダウンロードして使う"
              : "ダウンロードして使う";
    node("Cancel").hidden = !ownPull;
    node("Cancel").disabled = modelBusy || pull?.status === "stopping";
    node("ProgressRow").hidden = !ownPull;
    if (ownPull && m) {
      node("Progress").value = m.partial / m.size;
      node("ProgressText").textContent =
        `${gb(m.partial)} / ${gb(m.size)} GB（${Math.floor((m.partial / m.size) * 100)}%）`;
    }
  }
  $("modelDir").disabled = busy;
  $("modelDirSave").disabled = busy;
  $("modelDirReset").disabled = busy || dir === defaultDir;
  $("modelDirDefault").textContent = `既定: ${defaultDir}`;
}
async function refreshModels(opening = false) {
  if (modelBusy || shuttingDown) return;
  if (modelRequest) return modelRequest;
  clearTimeout(modelTimer);
  const generation = modelGeneration;
  modelRequest = (async () => {
    try {
      const data = await api("models");
      if (generation !== modelGeneration) return;
      if (!modelsOpened || modelState?.dir !== data.dir)
        $("modelDir").value = data.dir;
      if ((!modelsOpened || opening) && pulling(data.pull))
        trackedPull = {
          id: data.pull.id,
          catalog:
            catalogs.find(
              (c) =>
                c.task ===
                modelTask(
                  data.models.find((m) => m.choice === data.pull.choice),
                ),
            ) ?? catalogs[0],
        };
      modelsOpened = true;
      modelState = data;
      for (const { prefix } of catalogs) {
        $(`${prefix}ListError`).hidden = true;
        $(`${prefix}Body`).hidden = false;
      }
      if (
        trackedPull &&
        data.pull?.id === trackedPull.id &&
        !pulling(data.pull)
      ) {
        const catalog = trackedPull.catalog;
        trackedPull = undefined;
        if (data.pull.status === "done") {
          $(catalog.field).value = data.pull.path;
          modelStatus(
            "ダウンロードしました。「次回起動の設定を保存」を押してから、Bridgeを再起動してください。",
            false,
            catalog,
          );
        } else if (data.pull.status === "cancelled")
          modelStatus(
            "中止しました。もう一度押すと、続きからダウンロードします。",
            false,
            catalog,
          );
        else
          modelStatus(
            data.pull.error || "ダウンロードに失敗しました。",
            true,
            catalog,
          );
      } else if (trackedPull && data.pull?.id !== trackedPull.id)
        trackedPull = undefined;
      renderModels();
    } catch (e) {
      if (generation !== modelGeneration) return;
      for (const { prefix } of catalogs) {
        $(`${prefix}ListError`).textContent = e.message;
        $(`${prefix}ListError`).hidden = false;
        // Keep cancellation available if polling temporarily fails mid-download.
        $(`${prefix}Body`).hidden = !modelState;
      }
    } finally {
      modelRequest = undefined;
      if (
        !shuttingDown &&
        !modelBusy &&
        (pulling(modelState?.pull) || trackedPull)
      )
        modelTimer = setTimeout(() => refreshModels(), 1000);
    }
  })();
  return modelRequest;
}
async function modelAction(fn, catalog = catalogs[0]) {
  if (modelBusy) return;
  modelBusy = true;
  modelGeneration++;
  clearTimeout(modelTimer);
  renderModels();
  try {
    await fn();
  } catch (e) {
    modelStatus(e.message, true, catalog);
  } finally {
    modelBusy = false;
    // Discard a pre-mutation response before requesting the new job snapshot.
    await modelRequest;
    await refreshModels();
    renderModels();
  }
}
for (const catalog of catalogs) {
  const { prefix, field } = catalog;
  $(`${prefix}Model`).onchange = () => {
    modelStatus("", false, catalog);
    renderModels();
    void refreshModels();
  };
  $(`${prefix}Use`).onclick = () =>
    modelAction(async () => {
      if (pulling(modelState?.pull)) return;
      const m = modelState.models.find(
        (m) => m.choice === $(`${prefix}Model`).value,
      );
      if (!m) return;
      if (m.fetched) {
        $(field).value = m.path;
        modelStatus(
          "パスを入れました。「次回起動の設定を保存」を押してから、Bridgeを再起動してください。",
          false,
          catalog,
        );
      } else {
        modelStatus("", false, catalog);
        const { id } = await api("models/pull", "POST", { choice: m.choice });
        trackedPull = { id, catalog };
      }
    }, catalog);
  $(`${prefix}Cancel`).onclick = () =>
    modelAction(() => api("models/pull", "DELETE"), catalog);
}
async function saveModelDir(dir) {
  // Drain a prior poll so its old snapshot cannot overwrite the mutation result.
  await modelRequest;
  modelState = await api("models/dir", "PUT", { dir });
  $("modelDir").value = modelState.dir;
  for (const catalog of catalogs) modelStatus("", false, catalog);
}
$("modelDirSave").onclick = () =>
  modelAction(() => saveModelDir($("modelDir").value.trim()));
$("modelDirReset").onclick = () => modelAction(() => saveModelDir(""));
let creditsLoaded = false;
$("credits").addEventListener("toggle", async () => {
  if (!$("credits").open || creditsLoaded) return;
  try {
    const data = await api("credits");
    const nodes = data.entries.map((entry) => {
      const section = document.createElement("section");
      const title = document.createElement("h3");
      title.textContent = entry.title;
      const link = document.createElement("a");
      link.href = entry.url;
      link.textContent = entry.linkText;
      link.target = "_blank";
      link.rel = "noopener";
      const note = document.createElement("p");
      note.textContent = entry.note || "";
      const license = document.createElement("pre");
      license.textContent = entry.license;
      section.append(title, link, note, license);
      return section;
    });
    const footer = document.createElement("p");
    footer.textContent = data.footer;
    $("creditsBody").replaceChildren(...nodes, footer);
    creditsLoaded = true;
  } catch (e) {
    $("creditsBody").textContent = e.message;
  }
});
