const $ = (id) => document.getElementById(id);
let accepting = false,
  provider,
  publishText,
  sentencePauseMs;
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
async function refresh() {
  const [d, pending] = await Promise.all([api("diagnostics"), api("pairings")]);
  accepting = d.accepting;
  $("toggle").textContent = accepting ? "読み上げ停止" : "読み上げ開始";
  $("toggle").disabled = false;
  $("connection").textContent =
    `Irodori: ${d.tts.status === "unreachable" ? "接続できません" : "接続済み"} ／ 読み上げ${accepting ? "中" : "停止中"}`;
  $("collectors").textContent = d.collectors.length
    ? d.collectors
        .map(
          (c) =>
            `${c.source.adapter} / ${c.source.contextId}: ${c.online ? "接続中" : "切断"} — ${c.diagnostic}`,
        )
        .join("\n")
    : "Collector: 未接続（VTTのタブで拡張機能を開いて接続してください）";
  $("participants").textContent = `参加者: ${d.players.length} 接続`;
  $("recovery").hidden = !d.degraded;
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
  publishText = config.publishTextToPlayers;
  sentencePauseMs = config.sentencePauseMs ?? 900;
  $("providerUrl").value = provider.baseUrl;
  $("publishText").checked = publishText;
  $("sentencePause").value = sentencePauseMs / 1000;
  await refresh();
  setInterval(() => run(refresh), 5000);
});
