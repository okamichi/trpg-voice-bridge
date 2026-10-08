const form = document.getElementById("settings"),
  status = document.getElementById("status");
let detected,
  tabId,
  site,
  detectSequence = 0,
  busy = false;
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw new Error(result.error);
  return result;
}
async function pairing(bridge) {
  const stored =
    (await chrome.storage.local.get("authorizations")).authorizations ?? {};
  const auth = stored[bridge] ?? {
    key: [...crypto.getRandomValues(new Uint8Array(32))]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join(""),
  };
  if (auth.token) return auth.token;
  const r = await fetch(bridge + "/api/v1/pairings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: auth.key }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  if (data.status === "rejected") {
    delete stored[bridge];
    await chrome.storage.local.set({ authorizations: stored });
    throw new Error("接続が拒否されました。再度接続してください。");
  }
  if (data.token) auth.token = data.token;
  stored[bridge] = auth;
  await chrome.storage.local.set({ authorizations: stored });
  if (!auth.token)
    status.textContent = `確認コード: ${data.code} — 管理画面でこのコードの接続を承認してください。承認後にVTTのタブへ戻り「このタブを接続」を押してください。`;
  return auth.token;
}
async function detect() {
  const sequence = ++detectSequence;
  detected = null;
  document.getElementById("connect").disabled = true;
  document.getElementById("detected").textContent =
    "現在のタブを確認しています…";
  try {
    const saved = await chrome.storage.local.get(["rooms"]);
    const result = await send({
      type: "detect",
      tabId,
      mode: form.elements.mode.value,
    });
    if (sequence !== detectSequence) return;
    detected = result;
    document.getElementById("detected").textContent =
      `${detected.adapter === "fvtt" ? "FVTT" : detected.variant === "fly" ? "ユドナリウム with Fly" : "ユドナリウム"} / ${detected.contextId || "部屋の識別名を入力してください"}`;
    form.elements.contextId.value =
      detected.contextId ||
      form.elements.contextId.value ||
      saved.rooms?.[detected.instanceId] ||
      "";
    form.elements.channel.value = detected.channel || "";
    document.getElementById("roomField").hidden = !!detected.contextId;
    document.getElementById("channelField").hidden = !!detected.channel;
    const choices = form.elements.channelChoice;
    choices.replaceChildren();
    for (const c of detected.channels ?? []) {
      const option = document.createElement("option");
      option.value = c.id;
      option.textContent = `${c.name || "無名のタブ"} (${c.id})`;
      choices.append(option);
    }
    choices.value = detected.channel || "";
    document.getElementById("channelSelectField").hidden =
      !detected.channels?.length;
    document.getElementById("connect").disabled = false;
    const d = await chrome.storage.session.get("diagnostic");
    status.textContent = d.diagnostic ?? "未接続";
  } catch (e) {
    if (sequence === detectSequence) status.textContent = e.message;
  }
}
(async () => {
  try {
    const saved = await chrome.storage.local.get(["bridge", "modes"]);
    form.elements.bridge.value = saved.bridge ?? "http://127.0.0.1:8090";
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    tabId = tab.id;
    const url = new URL(tab.url);
    site = url.origin + url.pathname;
    form.elements.mode.value = saved.modes?.[site] || "auto";
    await detect();
  } catch (e) {
    status.textContent = e.message;
    document.getElementById("connect").disabled = true;
  }
})();
form.elements.mode.onchange = async () => {
  const modes = (await chrome.storage.local.get("modes")).modes ?? {};
  modes[site] = form.elements.mode.value;
  await chrome.storage.local.set({ modes });
  await detect();
};
form.onsubmit = async (e) => {
  e.preventDefault();
  if (busy || !detected) return;
  busy = true;
  form.elements.mode.disabled = true;
  try {
    const url = new URL(form.elements.bridge.value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Bridge URLは http://127.0.0.1:ポート の形式で入力してください",
      );
    const bridge = url.origin;
    const contextId =
        detected.contextId || form.elements.contextId.value.trim(),
      channel = detected.channels?.length
        ? form.elements.channelChoice.value
        : detected.channel || form.elements.channel.value.trim();
    if (!contextId || !channel)
      throw new Error("部屋の識別名と対象チャットが必要です");
    const rooms = (await chrome.storage.local.get("rooms")).rooms ?? {};
    rooms[detected.instanceId] = contextId;
    await chrome.storage.local.set({ bridge, rooms });
    const token = await pairing(bridge);
    if (!token) return;
    try {
      await send({
        type: "connect",
        tabId,
        settings: { ...detected, contextId, channel, bridge, token },
      });
    } catch (e) {
      if (e.message.includes("Collectorトークン")) {
        const d = await chrome.storage.local.get("authorizations");
        delete d.authorizations[bridge];
        await chrome.storage.local.set(d);
        throw new Error(
          "承認が失効しました。もう一度接続して承認を受けてください。",
        );
      }
      throw e;
    }
    status.textContent =
      "接続しました。キャラとして公開発言するとPlayerに表示されます。";
  } catch (e) {
    status.textContent = e.message;
  } finally {
    busy = false;
    form.elements.mode.disabled = false;
  }
};
document.getElementById("stop").onclick = async () => {
  try {
    await send({ type: "stop" });
    status.textContent = "停止しました";
  } catch (e) {
    status.textContent = e.message;
  }
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.diagnostic && !busy)
    status.textContent = changes.diagnostic.newValue ?? "未接続";
});
