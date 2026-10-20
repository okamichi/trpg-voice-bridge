import {
  refreshCharacters,
  onCharacters,
  stopCharacterSettings,
} from "./characters.js";
import { bridge } from "./bridge-client.js";
import { mountChat } from "./chat-view.js";
import { Playback } from "./playback.js";
import { randomUUID } from "./uuid.js";
const $ = (id) => document.getElementById(id),
  clientId = randomUUID();
let socket,
  context,
  gain,
  source,
  finish,
  meta,
  baseline = 0,
  notificationSeq = 0,
  offset = 0,
  ended = false,
  resumeLatest = false,
  connecting = false,
  retry = 1000;
let chatGeneration = 0,
  chatEnabled = true;
function applyChatState(n) {
  const generation = n.chat?.generation ?? n.chatGeneration;
  if (generation === undefined) return true;
  if (generation < chatGeneration) return false;
  if (generation > chatGeneration) {
    $("caption").textContent = "";
  }
  chatGeneration = generation;
  chatEnabled = n.chat?.enabled ?? n.chatEnabled ?? chatEnabled;
  return true;
}
const muted = new Set(),
  unavailableAudio = new Set();
const channel = globalThis.BroadcastChannel
  ? new BroadcastChannel("trpg-voice-player")
  : null;
function status(text) {
  $("status").textContent = text;
}
function report(type, state, item) {
  if (socket?.readyState === 1)
    socket.send(JSON.stringify({ type, state, orderId: item?.orderId }));
}
const playback = new Playback({
  now: () => Date.now() + offset,
  load: async (item, signal) => {
    let last;
    for (let n = 0; n < 2; n++) {
      try {
        const r = await bridge.request(item.audio.url, { signal });
        if (Number(r.headers.get("content-length")) > 25 * 1024 * 1024)
          throw new Error("音声が大きすぎます");
        return await context.decodeAudioData(await r.arrayBuffer());
      } catch (e) {
        if (signal.aborted) throw e;
        if (e.status === 404) {
          unavailableAudio.add(item.orderId);
          chat.render();
          break;
        }
        last = e;
      }
    }
    throw last ?? new Error("この音声は保存期間が過ぎたため、再生できません");
  },
  play: (buffer) =>
    new Promise((resolve, reject) => {
      if (context.state !== "running") {
        stopAudio("音声を再開してください");
        reject(new Error("音声を再開してください"));
        return;
      }
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      finish = resolve;
      source.onended = () => {
        source = null;
        finish = null;
        resolve();
      };
      source.start();
    }),
  stop: () => {
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {}
      source.disconnect();
      source = null;
    }
    finish?.();
    finish = null;
  },
  onState: (state, item) => {
    if (state === "playing") {
      status("再生中");
      $("speaker").textContent = item.speakerName;
      $("caption").textContent =
        chatEnabled &&
        !item.chatDeleted &&
        item.chatGeneration === chatGeneration
          ? (item.text ?? "")
          : "";
      report("playback.started", "playing", item);
    } else if (state === "idle") {
      status("次の発言を待っています");
      report("playback.ended", "idle", item);
    } else if (state === "fetching") report("player.state", "fetching", item);
    else if (state === "error" || state === "blocked") {
      status(typeof item === "string" ? item : "音声を再開してください");
      report("playback.error", "blocked");
    }
  },
});
playback.muted = muted;
function canReplay(message) {
  return (
    !ended &&
    message.sessionId === meta?.sessionId &&
    message.audioStatus === "ready" &&
    message.audioOrders.length > 0 &&
    message.audioOrders.length === (message.audioOrders[0].parts ?? 1) &&
    message.audioOrders.every(
      (o) =>
        o.status === "ready" &&
        o.audio &&
        o.playbackEpoch === meta?.playbackEpoch &&
        !unavailableAudio.has(o.orderId) &&
        o.retainUntil > Date.now() + offset,
    )
  );
}
const chat = mountChat({
  client: bridge,
  canReplay,
  refreshCharacters: () => refreshCharacters(meta?.roomId),
  replay(message) {
    if (!playback.enabled) {
      status(`先に「${$("enable").textContent}」を押してください`);
      return;
    }
    if (!canReplay(message)) {
      chat.render();
      return;
    }
    const items = message.audioOrders.map((o) => ({
      ...o,
      sessionId: message.sessionId,
      bootId: meta.bootId,
      chatGeneration,
      text: message.text,
    }));
    if (playback.replay(items)) status("この発言を自分だけもう一度再生します");
  },
});
onCharacters((data) => chat.characters(data));
function renderLog() {
  chat.render();
}
function restoreLog(snapshot) {
  if (applyChatState(snapshot)) chat.state({ ...meta, ...snapshot }, true);
}
function addCharacter(n) {
  if (!n.characterId || document.getElementById(`mute-${n.characterId}`))
    return;
  const label = document.createElement("label"),
    box = document.createElement("input");
  box.type = "checkbox";
  box.id = `mute-${n.characterId}`;
  box.onchange = () =>
    box.checked ? muted.add(n.characterId) : muted.delete(n.characterId);
  label.append(box, document.createTextNode(n.speakerName));
  $("mutes").append(label);
}
function fresh(n) {
  meta = { ...meta, ...n };
  baseline = n.baseline;
  notificationSeq = n.notificationSeq;
  playback.reset(meta, baseline);
}
function stopAudio(message) {
  playback.disable();
  resumeLatest = true;
  $("enable").textContent = "音声を再開する";
  renderLog();
  status(message);
  report("player.state", "idle");
}
async function latest() {
  const snapshot = await bridge.json(
    bridge.room(meta?.roomId ?? "campaign-01", "state"),
  );
  if (ended) return;
  if (!applyChatState(snapshot)) return;
  fresh(snapshot);
  restoreLog(snapshot);
  status(
    playback.enabled
      ? "最新の発言から再生します"
      : "この画面の音声は停止中です。再開すると、新しい発言から再生します",
  );
}
function connect() {
  if (ended || connecting) return;
  connecting = true;
  socket = bridge.socket();
  socket.onopen = () => {
    connecting = false;
    socket.send(
      JSON.stringify({
        type: "hello",
        ...(bridge.token ? { token: bridge.token } : {}),
        clientId,
        resume: meta
          ? {
              bootId: meta.bootId,
              sessionId: meta.sessionId,
              playbackEpoch: meta.playbackEpoch,
              notificationSeq,
            }
          : null,
      }),
    );
  };
  socket.onmessage = (event) => {
    if (ended) return;
    const n = JSON.parse(event.data);
    if (!applyChatState(n)) return;
    if (n.type === "hello") {
      meta = { ...meta, ...n };
      chat.state(meta, true);
      refreshCharacters(n.roomId);
      offset = n.serverTime - Date.now();
      retry = 1000;
      if (!n.resumed) fresh(n);
      else meta = { ...meta, ...n };
      status(
        playback.enabled
          ? "接続しました"
          : "接続しました。この画面の音声は停止中です",
      );
      return;
    }
    if (n.type === "state.snapshot") {
      restoreLog(n);
      return;
    }
    if (n.type === "session.ended") {
      endConnection("セッションは終了しました");
      bridge.onExit?.(
        "セッションは終了しました。新しい招待で参加してください。",
      );
      return;
    }
    if (n.type === "playback.reset") {
      fresh(n);
      renderLog();
      status("読み上げが停止されました");
      return;
    }
    if (n.notificationSeq <= notificationSeq) return;
    if (n.notificationSeq !== notificationSeq + 1) {
      latest().catch((e) => status(e.message));
      return;
    }
    notificationSeq = n.notificationSeq;
    if (n.type === "chat.reset") {
      chat.state({ ...meta, ...n }, true);
      status(
        chatEnabled
          ? "チャットの表示を更新しました"
          : "チャットと本文の共有は停止中です",
      );
      return;
    }
    if (n.type === "characters.changed") {
      refreshCharacters(n.roomId);
      return;
    }
    addCharacter(n);
    if (n.type.startsWith("chat.message.")) chat.changed();
    if (n.type === "order.skipped") {
      unavailableAudio.add(n.orderId);
      chat.render();
    }
    if (playback.enabled) playback.accept(n);
  };
  socket.onclose = async () => {
    connecting = false;
    if (ended) return;
    chat.disconnected();
    status("切断されました。再接続しています…");
    report("player.state", "disconnected");
    try {
      await bridge.json(
        bridge.room(meta?.roomId ?? bridge.roomId ?? "campaign-01", "state"),
        {
          timeout: 3000,
        },
      );
    } catch (error) {
      if (error.status === 401) {
        endConnection(
          "参加資格が失効しています。新しい参加リンクを開いてください",
        );
        bridge.onExit?.(
          "参加資格が失効しました。新しい招待で参加してください。",
        );
        return;
      }
    }
    setTimeout(connect, retry + Math.random() * 400);
    retry = Math.min(retry * 2, 30000);
  };
  socket.onerror = () => socket.close();
}
$("enable").onclick = async () => {
  if (ended) return;
  if (playback.enabled) {
    stopAudio("この画面の音声を停止しました。ログと声の設定は引き続き使えます");
    return;
  }
  $("enable").disabled = true;
  try {
    channel?.postMessage({ type: "active", roomId: meta?.roomId, clientId });
    if (!context) {
      context = new AudioContext();
      gain = context.createGain();
      gain.gain.value = Number($("volume").value);
      gain.connect(context.destination);
      context.onstatechange = () => {
        if (context.state !== "running" && playback.enabled)
          stopAudio("音声が中断されています。再開してください");
      };
    }
    await context.resume();
    if (context.state !== "running")
      throw new Error("音声を再開できませんでした");
    if (resumeLatest) {
      await latest();
      resumeLatest = false;
    }
    const osc = context.createOscillator(),
      g = context.createGain();
    g.gain.value = 0.03;
    osc.connect(g).connect(gain);
    osc.start();
    osc.stop(context.currentTime + 0.08);
    playback.enable();
    $("enable").textContent = "音声を停止";
    renderLog();
    status("音声を有効にしました");
    report("player.ready", "idle");
  } catch (e) {
    status(e.message);
  } finally {
    $("enable").disabled = ended;
  }
};
if (channel)
  channel.onmessage = (e) => {
    if (
      e.data.type === "active" &&
      e.data.clientId !== clientId &&
      e.data.roomId === meta?.roomId
    ) {
      stopAudio("別のタブで音声を有効にしました。このタブは停止しています");
    }
  };
$("volume").oninput = () => {
  if (gain) gain.gain.value = Number($("volume").value);
};
$("latest").onclick = () => latest().catch((e) => status(e.message));
function endConnection(message) {
  ended = true;
  playback.disable();
  chat.stop();
  stopCharacterSettings();
  bridge.cancel();
  socket?.close();
  $("caption").textContent = "";
  $("speaker").textContent = "";
  $("enable").disabled = true;
  $("latest").disabled = true;
  $("newCharacterDialog").close();
  status(message);
}
$("leaveRoom").onclick = async () => {
  endConnection("退出しています…");
  $("leaveRoom").disabled = true;
  try {
    await bridge.json("/api/v1/leave", { method: "POST", body: {} });
    status("退出しました。再参加するには招待リンクを開いてください。");
    await bridge.onExit?.("退出しました。接続先と招待を入力して参加できます。");
  } catch (error) {
    if (error.status === 401) {
      status("参加資格はすでに失効しています。");
      await bridge.onExit?.(
        "参加資格が失効しました。新しい招待で参加してください。",
      );
    } else {
      status(
        "接続を停止しましたが、サーバー側の退出は未確認です。接続が戻ったら再試行してください。",
      );
      $("leaveRoom").textContent = "退出を再試行";
      $("leaveRoom").disabled = false;
    }
  }
};
for (const [button, panel] of [
  ["showChat", "chatPanel"],
  ["showSettings", "settingsPanel"],
])
  $(button).onclick = () => {
    for (const id of ["chatPanel", "settingsPanel"])
      $(id).hidden = id !== panel;
    for (const id of ["showChat", "showSettings"])
      $(id).setAttribute("aria-selected", String(id === button));
  };
window.addEventListener("pagehide", () => {
  endConnection("パネルを閉じました");
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
// Pasting another invite into this same tab is a fragment navigation, not a
// document navigation. Reload so it exchanges the invitation like a new tab.
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(location.hash.slice(1)).has("invite"))
    location.reload();
});
try {
  const invite = new URLSearchParams(location.hash.slice(1)).get("invite");
  history.replaceState(null, "", location.pathname);
  if (invite && !bridge.extensionOrigin) {
    await bridge.json("/api/v1/join", { method: "POST", body: { invite } });
  }
  connect();
} catch (e) {
  status(e.message);
}
