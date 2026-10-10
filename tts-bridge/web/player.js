import { refreshCharacters } from "./characters.js";
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
  connecting = false,
  retry = 1000;
const muted = new Set(),
  log = new Map();
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
        const r = await fetch(item.audio.url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        });
        if (r.status === 404) {
          const entry = log.get(item.orderId);
          if (entry) entry.unavailable = true;
          renderLog();
          last = new Error("この音声は保存期間が過ぎたため、再生できません");
          break;
        }
        if (!r.ok) throw new Error("音声を取得できません");
        if (Number(r.headers.get("content-length")) > 25 * 1024 * 1024)
          throw new Error("音声が大きすぎます");
        return await context.decodeAudioData(await r.arrayBuffer());
      } catch (e) {
        if (signal.aborted) throw e;
        last = e;
      }
    }
    throw last;
  },
  play: (buffer) =>
    new Promise((resolve, reject) => {
      if (context.state !== "running") {
        playback.enabled = false;
        $("enable").hidden = false;
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
      $("caption").textContent = item.text ?? "";
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
function replayable(entry) {
  return (
    !ended &&
    !entry.unavailable &&
    entry.item.sessionId === meta?.sessionId &&
    entry.item.playbackEpoch === meta?.playbackEpoch &&
    entry.item.retainUntil > Date.now() + offset
  );
}
// The log shows only audio that has been generated; replay is local to this page.
function addLog(item) {
  if (item.type !== "audio.ready" || !item.audio || log.has(item.orderId))
    return;
  const row = document.createElement("li"),
    info = document.createElement("div"),
    name = document.createElement("strong"),
    button = document.createElement("button"),
    entry = { item, row, button, unavailable: false };
  row.className = "list-item";
  info.className = "log-meta";
  name.textContent = item.speakerName;
  info.append(
    new Date(item.readyAt - offset).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    " ",
    name,
  );
  row.append(info);
  if (item.text) {
    const text = document.createElement("p");
    text.className = "log-text";
    text.textContent = item.text;
    row.append(text);
  }
  button.type = "button";
  button.className = "secondary";
  button.onclick = () => {
    if (!replayable(entry)) {
      renderLog();
      status("この音声は保存期間が過ぎたため、再生できません");
      return;
    }
    if (!playback.enabled) {
      $("enable").hidden = false;
      status("先に「音声を有効にする」を押してください");
      return;
    }
    const waiting = !!playback.current;
    if (playback.replay(item))
      status(
        waiting ? "今のセリフの後にもう一度再生します" : "もう一度再生します",
      );
  };
  row.append(button);
  log.set(item.orderId, entry);
}
function renderLog() {
  const entries = [...log.values()].sort(
    (a, b) => b.item.orderSeq - a.item.orderSeq,
  );
  for (const old of entries.splice(200)) log.delete(old.item.orderId);
  for (const entry of entries) {
    const ok = replayable(entry);
    entry.button.disabled = !ok;
    entry.button.textContent = ok ? "もう一度再生" : "再生できません";
  }
  $("log").replaceChildren(...entries.map((e) => e.row));
}
function restoreLog(snapshot) {
  for (const order of snapshot.orders ?? [])
    if (order.status === "ready")
      addLog({
        ...order,
        type: "audio.ready",
        bootId: snapshot.bootId,
        sessionId: snapshot.sessionId,
        roomId: snapshot.roomId,
        playbackEpoch: snapshot.playbackEpoch,
      });
  renderLog();
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
  meta = n;
  baseline = n.baseline;
  notificationSeq = n.notificationSeq;
  playback.reset(meta, baseline);
}
async function latest() {
  const r = await fetch(`/api/v1/rooms/${meta?.roomId ?? "campaign-01"}/state`);
  if (!r.ok) throw new Error("参加リンクを開き直してください");
  const snapshot = await r.json();
  fresh(snapshot);
  restoreLog(snapshot);
  status("最新の発言から再生します");
}
function connect() {
  if (ended || connecting) return;
  connecting = true;
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
  );
  socket.onopen = () => {
    connecting = false;
    socket.send(
      JSON.stringify({
        type: "hello",
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
    const n = JSON.parse(event.data);
    if (n.type === "hello") {
      refreshCharacters(n.roomId);
      offset = n.serverTime - Date.now();
      retry = 1000;
      if (!n.resumed) fresh(n);
      else meta = { ...meta, ...n };
      status(
        playback.enabled
          ? "接続しました"
          : "接続しました。音声を有効にしてください",
      );
      return;
    }
    if (n.type === "state.snapshot") {
      restoreLog(n);
      return;
    }
    if (n.type === "session.ended") {
      ended = true;
      playback.reset(n, n.baseline);
      renderLog();
      status("セッションは終了しました");
      socket.close();
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
    if (n.type === "characters.changed") {
      refreshCharacters(n.roomId);
      return;
    }
    addCharacter(n);
    if (n.type === "order.skipped" && log.has(n.orderId))
      log.get(n.orderId).unavailable = true;
    addLog(n);
    renderLog();
    playback.accept(n);
  };
  socket.onclose = async () => {
    connecting = false;
    if (ended) return;
    status("切断されました。再接続しています…");
    report("player.state", "disconnected");
    try {
      const r = await fetch(
        `/api/v1/rooms/${meta?.roomId ?? "campaign-01"}/state`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (r.status === 401) {
        ended = true;
        playback.disable();
        status("参加資格が失効しています。新しい参加リンクを開いてください");
        return;
      }
    } catch {}
    setTimeout(connect, retry + Math.random() * 400);
    retry = Math.min(retry * 2, 30000);
  };
  socket.onerror = () => socket.close();
}
$("enable").onclick = async () => {
  try {
    channel?.postMessage({ type: "active", roomId: meta?.roomId, clientId });
    if (!context) {
      context = new AudioContext();
      gain = context.createGain();
      gain.gain.value = Number($("volume").value);
      gain.connect(context.destination);
      context.onstatechange = () => {
        if (context.state !== "running") {
          status("音声が中断されています。再開してください");
          $("enable").hidden = false;
        }
      };
    }
    await context.resume();
    if (context.state !== "running")
      throw new Error("音声を再開できませんでした");
    const osc = context.createOscillator(),
      g = context.createGain();
    g.gain.value = 0.03;
    osc.connect(g).connect(gain);
    osc.start();
    osc.stop(context.currentTime + 0.08);
    playback.enable();
    $("enable").textContent = "音声を再開する";
    $("enable").hidden = true;
    status("音声を有効にしました");
    report("player.ready", "idle");
  } catch (e) {
    status(e.message);
  }
};
if (channel)
  channel.onmessage = (e) => {
    if (
      e.data.type === "active" &&
      e.data.clientId !== clientId &&
      e.data.roomId === meta?.roomId
    ) {
      playback.disable();
      $("enable").hidden = false;
      status("別のタブで音声を有効にしました。このタブは停止しています");
    }
  };
$("volume").oninput = () => {
  if (gain) gain.gain.value = Number($("volume").value);
};
$("latest").onclick = () => latest().catch((e) => status(e.message));
setInterval(renderLog, 30000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && context?.state !== "running")
    $("enable").hidden = false;
});
try {
  const invite = new URLSearchParams(location.hash.slice(1)).get("invite");
  history.replaceState(null, "", location.pathname);
  if (invite) {
    const r = await fetch("/api/v1/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invite }),
    });
    if (!r.ok)
      throw new Error(
        "招待が失効しています。音声担当者から新しいリンクを受け取ってください",
      );
  }
  connect();
} catch (e) {
  status(e.message);
}
