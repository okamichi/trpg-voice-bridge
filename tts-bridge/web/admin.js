const $ = (id) => document.getElementById(id);
let runtimeInitialized = false,
  runtimeState;
let accepting = false,
  provider,
  chatVoiceRegistrationEnabled = false,
  deliveryCaptionMode,
  publishText,
  sentencePauseMs,
  sentenceSplitThresholdChars;
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
    $("notice").textContent = e.message;
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
  $("providerForm").querySelector("button").disabled = bundled;
  $("providerNote").hidden = !bundled;
}
async function refresh() {
  const [d, pending] = await Promise.all([api("diagnostics"), api("pairings")]);
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
      starting: "モデル読込中",
      ready: "準備完了",
      error: "起動失敗",
    };
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
      runtimeInitialized = true;
    }
    applyRuntimeView();
  }
  const registrations = (d.voiceCommands ?? []).filter(
    (x) => x.status === "failed",
  );
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
    `Irodori-TTS: ${["unreachable", "error", "starting", "stopped"].includes(d.tts.status) ? "未接続・準備中" : "接続済み"} ／ 読み上げ${accepting ? "中" : "停止中"}`;
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
        ? "Playerにセリフの本文を表示します。"
        : "Playerにはセリフの本文を表示しません。";
    } finally {
      $("publishText").checked = publishText;
    }
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
await run(async () => {
  const access = new URLSearchParams(location.hash.slice(1)).get("access");
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
  $("providerUrl").value = provider.baseUrl;
  $("deliveryCaptionMode").value = deliveryCaptionMode;
  $("publishText").checked = publishText;
  $("sentencePause").value = sentencePauseMs / 1000;
  $("sentenceSplitThreshold").value = sentenceSplitThresholdChars;
  await refresh();
  setInterval(() => run(refresh), 5000);
  for (const extension of await api("extensions")) {
    const row = document.createElement("tr"),
      label = document.createElement("th"),
      connectionStatus = document.createElement("td");
    label.scope = "row";
    label.textContent = extension.title;
    connectionStatus.textContent = "確認しています…";
    row.append(label, connectionStatus);
    $("connectionRows").append(row);
    const container = document.createElement("div");
    $("extensions").append(container);
    try {
      const { mount } = await import(extension.script);
      await mount(container, {
        setConnectionStatus: (text) => {
          connectionStatus.textContent = text;
        },
        api: (path, method, body) =>
          api(`ext/${extension.id}/${path}`, method, body),
      });
    } catch {
      connectionStatus.textContent = "読み込めませんでした";
      container.textContent = `${extension.title}: 読み込めませんでした`;
    }
  }
});

$("runtimeMode").onchange = applyRuntimeView;
$("runtimeForm").onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    // The external mode keeps the last bundled build for a later switch back.
    const [mode, backend = runtimeState.saved.backend] =
      $("runtimeMode").value.split(":");
    await api("runtime", "PUT", {
      mode,
      backend,
      model: $("runtimeModel").value.trim(),
      ttsPort: Number($("runtimePort").value),
    });
    await refresh();
  });
};
$("shutdownBridge").onclick = () =>
  run(async () => {
    await api("shutdown", "POST", {});
    $("runtimeStatus").textContent =
      "Bridgeを終了しています。この画面を閉じてからBridgeを起動し直してください。";
  });
