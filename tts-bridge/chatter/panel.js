import { bridge } from "./shared/bridge-client.js";
const $ = (id) => document.getElementById(id);
bridge.extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
let exiting = false;
function address(value) {
  const url = new URL(value);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "BridgeのURLは http:// または https:// で始まる接続先だけを入力してください",
    );
  return url.origin;
}
// Chrome host permissions cover every port; the transport and server also
// enforce the exact selected origin (including port).
function permission(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.hostname}/*`;
}
function inviteCode(value, baseUrl) {
  let code = value.trim();
  if (/^https?:\/\//.test(code)) {
    const url = new URL(code);
    if (url.origin !== baseUrl || url.username || url.password)
      throw new Error("招待リンクとBridgeの接続先が異なります");
    code = new URLSearchParams(url.hash.slice(1)).get("invite") ?? "";
  }
  if (!/^[a-f0-9]{64}$/.test(code))
    throw new Error("有効な招待リンクまたは招待コードを入力してください");
  return code;
}
bridge.onExit = async (notice) => {
  exiting = true;
  const { participant } = await chrome.storage.session.get("participant");
  // Another window may already have joined a different room.
  if (participant?.token === bridge.token) {
    await chrome.storage.session.remove("participant");
    await chrome.storage.session.set({ notice });
  }
  location.reload();
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === "session" &&
    changes.participant &&
    bridge.token &&
    !exiting &&
    changes.participant.newValue?.token !== bridge.token
  )
    location.reload();
});
chrome.permissions.onRemoved.addListener(() => location.reload());
async function start(saved) {
  bridge.baseUrl = saved.baseUrl;
  bridge.token = saved.token;
  bridge.roomId = saved.roomId;
  await bridge.json(bridge.room(saved.roomId, "state"));
  $("connection").hidden = true;
  $("participant").hidden = false;
  $("connectionAddress").textContent = saved.baseUrl;
  await import("./shared/player.js");
}
$("connectionForm").onsubmit = async (event) => {
  event.preventDefault();
  $("joinChatter").disabled = true;
  try {
    const baseUrl = address($("bridgeAddress").value.trim());
    const invite = inviteCode($("invitation").value, baseUrl);
    // Call request directly from the submit gesture, before any async work.
    const allowed = await chrome.permissions.request({
      origins: [permission(baseUrl)],
    });
    if (!allowed)
      throw new Error(
        "接続先へのアクセスが許可されませんでした。参加するには許可が必要です。",
      );
    $("connectionStatus").textContent = "参加しています…";
    bridge.baseUrl = baseUrl;
    bridge.token = undefined;
    const joined = await bridge.json("/api/v1/chatter/join", {
      method: "POST",
      body: { invite },
    });
    $("invitation").value = "";
    const saved = { baseUrl, ...joined };
    bridge.token = joined.token;
    await chrome.storage.session.set({ participant: saved });
    await chrome.storage.local.set({ bridgeUrl: baseUrl });
    $("connectionForm").hidden = true;
    await start(saved);
  } catch (error) {
    $("connectionStatus").textContent = bridge.token
      ? "参加資格は保存しましたが接続できませんでした。接続先を確認してパネルを開き直してください。"
      : error.message;
  } finally {
    $("joinChatter").disabled = false;
  }
};
try {
  const [{ participant, notice }, { bridgeUrl }] = await Promise.all([
    chrome.storage.session.get(["participant", "notice"]),
    chrome.storage.local.get("bridgeUrl"),
  ]);
  $("bridgeAddress").value = bridgeUrl ?? "http://127.0.0.1:8090";
  $("connectionStatus").textContent =
    notice ?? "管理者から受け取った招待リンクを入力してください。";
  await chrome.storage.session.remove("notice");
  if (participant) {
    bridge.baseUrl = address(participant.baseUrl);
    bridge.token = participant.token;
    if (participant.expires <= Date.now()) {
      await bridge.onExit(
        "参加資格が失効しました。新しい招待で参加してください。",
      );
    } else if (
      await chrome.permissions.contains({
        origins: [permission(participant.baseUrl)],
      })
    ) {
      try {
        await start(participant);
      } catch (error) {
        if (error.status === 401 || error.status === 403)
          await bridge.onExit(
            "参加資格が失効しました。新しい招待で参加してください。",
          );
        else {
          // Keep the existing credential, including its idempotency identity.
          $("connectionForm").hidden = true;
          $("connectionStatus").textContent =
            "接続できませんでした。接続先の起動を確認して、パネルを開き直してください。";
        }
      }
    } else {
      $("connectionForm").hidden = true;
      $("connectionStatus").textContent =
        "接続先へのアクセス許可が取り消されています。Chromeの拡張設定で許可を戻して、パネルを開き直してください。";
    }
  }
} catch (error) {
  $("connectionStatus").textContent = error.message;
}
