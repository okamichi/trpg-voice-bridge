let active = null,
  outbox = [],
  sending = false;
const status = (diagnostic) => chrome.storage.session.set({ diagnostic });
async function restore() {
  if (!active) {
    const d = await chrome.storage.session.get("active");
    active = d.active ?? null;
  }
  return active;
}
async function request(path, body) {
  const s = active.settings;
  const r = await fetch(s.bridge + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${s.token}`,
      "X-Collector-Id": active.collectorId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(data.error ?? `HTTP ${r.status}`), {
      status: r.status,
    });
  return data;
}
function source() {
  const s = active.settings;
  return {
    adapter: s.adapter,
    instanceId: s.instanceId,
    contextId: s.contextId,
  };
}
async function heartbeat() {
  await restore();
  if (!active) return;
  const state = await request("/api/v1/collectors/heartbeat", {
    source: source(),
    collectorId: active.collectorId,
    diagnostic: active.diagnostic ?? "接続中",
  });
  if (state.sessionId !== active.sessionId) {
    await stop();
    await status("卓が終了しました。再接続してください");
    return;
  }
  active.accepting = state.accepting;
  await chrome.storage.session.set({ active });
  await flush();
}
async function stop() {
  await restore();
  if (active) {
    try {
      await request("/api/v1/collectors/disconnect", {
        source: source(),
        collectorId: active.collectorId,
      });
    } catch {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId: active.tabId },
        world: "MAIN",
        func: () => globalThis.__trpgCollectorStop?.(),
      });
    } catch {}
  }
  active = null;
  outbox = [];
  await chrome.storage.session.remove("active");
  await chrome.alarms.clear("trpg-heartbeat");
}
async function connect(settings, tabId) {
  await stop();
  const url = new URL(settings.bridge);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Bridge URLは http://127.0.0.1:ポート の形式にしてください",
    );
  settings.bridge = url.origin;
  active = { settings, tabId, collectorId: crypto.randomUUID() };
  const state = await request("/api/v1/collectors/connect", {
    source: source(),
    collectorId: active.collectorId,
    diagnostic: "アダプター初期化中",
  });
  Object.assign(active, {
    sessionId: state.sessionId,
    roomId: state.roomId,
    accepting: state.accepting,
  });
  await chrome.storage.session.set({ settings, active });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["relay.js"],
    world: "ISOLATED",
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (s) => {
      globalThis.__trpgCollectorSettings = s;
    },
    args: [
      {
        adapter: settings.adapter,
        contextId: settings.contextId,
        channel: settings.channel,
      },
    ],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["page.js"],
    world: "MAIN",
  });
  await chrome.alarms.create("trpg-heartbeat", { periodInMinutes: 0.5 });
}
async function flush() {
  if (sending || !active) return;
  sending = true;
  try {
    while (outbox.length && active) {
      const item = outbox[0];
      if (Date.now() - item.time > 10000) {
        outbox.shift();
        await status("通信中断で期限切れの発言を破棄しました");
        continue;
      }
      try {
        await request("/api/v1/events", item.event);
        outbox.shift();
      } catch (e) {
        await status(e.message);
        if (e.status && e.status !== 429 && e.status < 500) {
          outbox.shift();
          continue;
        }
        setTimeout(() => flush(), 1000);
        break;
      }
    }
  } finally {
    sending = false;
  }
}
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  (async () => {
    if (m.type === "detect") {
      if (sender.url !== chrome.runtime.getURL("popup.html"))
        throw new Error("ポップアップから操作してください");
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: m.tabId },
        world: "MAIN",
        func: () => {
          if (globalThis.game?.ready && typeof game.world?.id === "string")
            return {
              adapter: "fvtt",
              contextId: game.world.id,
              channel: "main",
              site: location.origin + location.pathname,
            };
          const roots = [...document.querySelectorAll("chat-tab")].filter(
            (e) => e.getClientRects().length,
          );
          if (roots.length !== 1)
            return {
              error:
                "FVTTのワールド、またはユドナリウムの公開チャットを一つ開いてください",
            };
          let tab;
          try {
            tab = globalThis.ng?.getComponent(roots[0])?.chatTab;
          } catch {}
          return {
            adapter: "udonarium",
            contextId: "",
            channel: tab?.identifier ?? "",
            site: location.origin + location.pathname,
          };
        },
      });
      const d = result.result;
      if (!d || d.error) throw new Error(d?.error ?? "VTTを検出できません");
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(d.site),
      );
      const instanceId =
        "vtt-" +
        [...new Uint8Array(digest)]
          .slice(0, 12)
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
      return {
        adapter: d.adapter,
        contextId: d.contextId,
        channel: d.channel,
        instanceId,
      };
    }
    if (m.type === "connect") {
      if (sender.url !== chrome.runtime.getURL("popup.html"))
        throw new Error("ポップアップから接続してください");
      await connect(m.settings, m.tabId);
      return { ok: true };
    }
    if (m.type === "stop") {
      if (sender.url !== chrome.runtime.getURL("popup.html"))
        throw new Error("ポップアップから停止してください");
      await stop();
      return { ok: true };
    }
    await restore();
    if (!active || sender.tab?.id !== active.tabId || sender.frameId !== 0)
      return {};
    if (m.type === "diagnostic") {
      active.diagnostic = String(m.payload).slice(0, 300);
      await status(active.diagnostic);
      await chrome.storage.session.set({ active });
      await heartbeat();
    }
    if (m.type === "event") {
      const p = m.payload;
      if (
        !p ||
        typeof p.text !== "string" ||
        !p.text.trim() ||
        [...p.text].length > 500 ||
        typeof p.messageId !== "string" ||
        typeof p.speaker?.name !== "string" ||
        p.contextId !== active.settings.contextId ||
        p.channel !== "main"
      )
        return {};
      if (outbox.length >= 30) {
        await status("送信待ちが満杯です");
        return {};
      }
      const e = {
        schemaVersion: 1,
        eventId: crypto.randomUUID(),
        roomId: active.roomId,
        sessionId: active.sessionId,
        source: { ...source(), messageId: p.messageId, revision: 0 },
        speaker: p.speaker,
        channel: "main",
        visibility: "public",
        kind: "dialogue",
        text: p.text,
        occurredAt: p.occurredAt,
      };
      outbox.push({ event: e, time: Date.now() });
      await flush();
    }
    return { ok: true };
  })().then(respond, (e) => {
    status(e.message);
    respond({ error: e.message });
  });
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "trpg-heartbeat")
    heartbeat().catch((e) => status(e.message));
});
