import { ChatHistory } from "./chat-history.js";
import { randomUUID } from "./uuid.js";

// Same text as GENERATION_TIMEOUT in src/engine.mjs.
const GENERATION_TIMEOUT = "生成処理タイムアウト";
const GENERATION_TIMEOUT_HINT =
  "処理がタイムアウトしました。セリフの文字数を少なくするか、軽いモデルに切り替えてください。";

export function mountChat({ client, replay, canReplay, refreshCharacters }) {
  const $ = (id) => document.getElementById(id);
  let meta,
    key,
    prefs = {},
    characters = [],
    charactersLoaded = false,
    sending = false,
    composing = false;
  let connected = false,
    stopped = false,
    operation = 0,
    newCount = 0,
    shown = new Set();
  const rows = new Map();
  let selectionKey;
  const note = (text) => {
    $("chatStatus").textContent = text;
  };
  const history = new ChatHistory({
    client,
    changed: render,
    error: (error) =>
      note(
        error.status === 403
          ? "チャットと本文の共有は停止中です"
          : error.message,
      ),
  });
  function save() {
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(prefs));
    } catch {
      note(
        "このブラウザでは下書きを保存できません。ページを閉じる前にコピーしてください。",
      );
    }
  }
  function controls() {
    const available = connected && !stopped && history.enabled;
    $("sendMessage").disabled =
      !available ||
      sending ||
      !charactersLoaded ||
      !prefs.selected ||
      !!prefs.pending;
    $("retryMessage").hidden = !prefs.pending;
    $("retryMessage").disabled = !available || sending;
    $("editMessage").hidden = !prefs.pending;
    $("editMessage").disabled = sending;
    $("messageText").readOnly = sending || !!prefs.pending;
    $("speakingCharacter").disabled = sending || !!prefs.pending;
    $("createCharacter").disabled = !connected || stopped || sending;
    $("favoriteCharacter").disabled = !prefs.selected || sending;
    $("favoriteCharacter").textContent = prefs.favorites?.includes(
      prefs.selected,
    )
      ? "★ お気に入り"
      : "☆ お気に入り";
    $("sendStatus").textContent = sending
      ? "送信中…"
      : prefs.pending
        ? "送信結果を確認できません。同じ発言として再送できます。"
        : "";
  }
  function selectCharacters() {
    const select = $("speakingCharacter");
    const valid = characters.some((c) => c.id === prefs.selected);
    const previous = prefs.selected;
    if (charactersLoaded && !valid && !prefs.pending)
      prefs.selected = characters[0]?.id ?? "";
    const nextKey = JSON.stringify([
      characters.map(({ id, displayName }) => [id, displayName]),
      prefs.selected,
      prefs.favorites,
      !!prefs.pending,
    ]);
    if (nextKey === selectionKey) {
      controls();
      return;
    }
    selectionKey = nextKey;
    const sorted = [...characters].sort(
      (a, b) =>
        Number(prefs.favorites?.includes(b.id)) -
          Number(prefs.favorites?.includes(a.id)) ||
        a.displayName.localeCompare(b.displayName, "ja"),
    );
    select.replaceChildren(new Option("発言キャラを選択", ""));
    for (const c of sorted) {
      const sameName =
        characters.filter((x) => x.displayName === c.displayName).length > 1;
      select.add(
        new Option(
          `${prefs.favorites?.includes(c.id) ? "★ " : ""}${c.displayName}${sameName ? ` (${c.id.slice(0, 8)})` : ""}`,
          c.id,
        ),
      );
    }
    if (prefs.pending && !valid)
      select.add(
        new Option("削除済みのキャラ（送信結果確認用）", prefs.selected),
      );
    select.value = prefs.selected ?? "";
    if (previous !== prefs.selected) save();
    controls();
  }
  const audioLabels = {
    pending: "音声を確認中",
    queued: "生成待ち",
    synthesizing: "生成中",
    ready: "音声あり",
    ignored: "読み上げなし",
    failed: "生成失敗",
    cancelled: "読み上げ中断",
    interrupted: "読み上げ中断",
    expired: "音声期限切れ",
  };
  function render({ initial = false, reset = false, older = false } = {}) {
    const log = $("log");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    const top = log.scrollTop,
      height = log.scrollHeight;
    if (reset) {
      shown.clear();
      rows.clear();
      log.replaceChildren();
      newCount = 0;
    }
    if (initial || reset || atBottom) history.trim(100);
    const messages = [...history.messages.values()].sort(
      (a, b) => a.seq - b.seq,
    );
    const additions = messages.filter((m) => !shown.has(m.id)).length;
    shown = new Set(messages.map((m) => m.id));
    for (const [id, entry] of rows) {
      if (!history.messages.has(id)) {
        entry.row.remove();
        rows.delete(id);
      }
    }
    let position = log.firstElementChild;
    for (const m of messages) {
      const playable = canReplay(m);
      let entry = rows.get(m.id);
      if (
        !entry ||
        entry.updated !== m.updated ||
        entry.playable !== playable
      ) {
        const row = document.createElement("li");
        row.className = "list-item";
        row.dataset.messageId = m.id;
        const heading = document.createElement("div"),
          name = document.createElement("strong");
        heading.className = "log-meta";
        name.textContent = m.speakerName;
        heading.append(
          name,
          " ",
          new Date(m.createdAt).toLocaleTimeString("ja-JP", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        );
        const text = document.createElement("p");
        text.className = "log-text";
        text.textContent = m.text;
        const state = document.createElement("small");
        if (
          m.audioStatus === "failed" &&
          m.audioReason === GENERATION_TIMEOUT
        ) {
          state.textContent = GENERATION_TIMEOUT;
          state.title = GENERATION_TIMEOUT_HINT;
          state.className = "audio-timeout";
        } else
          state.textContent = [
            audioLabels[m.audioStatus] ?? m.audioStatus,
            m.audioReason,
          ]
            .filter(Boolean)
            .join("：");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = "もう一度再生";
        button.disabled = !playable;
        button.onclick = () => replay(m);
        row.append(heading, text, state, " ", button);
        if (entry) {
          if (position === entry.row) position = row;
          entry.row.replaceWith(row);
        }
        entry = { row, updated: m.updated, playable };
        rows.set(m.id, entry);
      }
      if (entry.row !== position) log.insertBefore(entry.row, position);
      position = entry.row.nextElementSibling;
    }
    if (older) log.scrollTop = top + log.scrollHeight - height;
    else if (initial || reset || atBottom) {
      log.scrollTop = log.scrollHeight;
      newCount = 0;
    } else {
      log.scrollTop = top;
      newCount += additions;
    }
    $("newMessages").hidden = !newCount;
    $("newMessages").textContent = `新着 ${newCount}件・最新へ`;
    if (!history.enabled && !stopped)
      note(
        "チャットと本文の共有は停止中です。読み上げの停止とは別の設定です。",
      );
    controls();
  }
  function state(next, online = connected) {
    if (stopped) return;
    meta = { ...meta, ...next };
    connected = online;
    const nextKey = `trpg-chat:${client.baseUrl}:${meta.roomId}`;
    if (nextKey !== key) {
      key = nextKey;
      characters = [];
      charactersLoaded = false;
      try {
        prefs = JSON.parse(localStorage.getItem(key) || "{}") || {};
      } catch {
        prefs = {};
      }
      if (typeof prefs !== "object" || Array.isArray(prefs)) prefs = {};
      prefs.favorites = Array.isArray(prefs.favorites) ? prefs.favorites : [];
      $("messageText").value = prefs.draft ?? "";
    }
    if (
      prefs.pending &&
      meta.participantId &&
      (prefs.pending.participantId !== meta.participantId ||
        prefs.pending.body.sessionId !== meta.sessionId)
    ) {
      delete prefs.pending;
      save();
      note(
        "再参加前の未確認の発言を下書きに戻しました。履歴を確認してから送信してください。",
      );
    }
    const wasEnabled = history.enabled;
    history.state(meta);
    if (wasEnabled === false && history.enabled)
      note("チャットの共有が再開されました。");
    selectCharacters();
  }
  async function send(retry = false) {
    if (sending || !connected || stopped || !history.enabled) return;
    if (!retry && prefs.pending) return;
    if (!retry) {
      const text = $("messageText").value;
      if (!text.trim() || [...text].length > 500) {
        note("メッセージは1～500文字で入力してください。");
        return;
      }
      if (!characters.some((c) => c.id === prefs.selected)) {
        note("発言キャラを選択してください。");
        return;
      }
      prefs.pending = {
        participantId: meta.participantId,
        body: {
          text,
          characterId: prefs.selected,
          sessionId: meta.sessionId,
          clientMessageId: randomUUID(),
        },
      };
      prefs.draft = text;
      save();
    }
    const op = operation;
    const pending = prefs.pending;
    if (!pending) return;
    sending = true;
    controls();
    try {
      const result = await client.json(client.room(meta.roomId, "messages"), {
        method: "POST",
        body: pending.body,
      });
      if (op !== operation || stopped) return;
      prefs.draft = "";
      delete prefs.pending;
      $("messageText").value = "";
      save();
      note(
        result.deleted
          ? "受付済みの発言です。履歴は消去されています。"
          : "送信しました",
      );
      history.sync();
    } catch (error) {
      if (op === operation && !stopped)
        note(`${error.message} 本文は下書きに残しています。`);
    } finally {
      if (op === operation) {
        sending = false;
        controls();
      }
    }
  }
  $("chatComposer").onsubmit = (event) => {
    event.preventDefault();
    send();
  };
  $("retryMessage").onclick = () => send(true);
  $("editMessage").onclick = () => {
    delete prefs.pending;
    save();
    controls();
    note(
      "編集後は新しい発言として送信します。送信済みか履歴を確認してください。",
    );
    $("messageText").focus();
  };
  $("messageText").oninput = () => {
    prefs.draft = $("messageText").value;
    save();
  };
  $("messageText").addEventListener("compositionstart", () => {
    composing = true;
  });
  $("messageText").addEventListener("compositionend", () => {
    composing = false;
  });
  $("messageText").onkeydown = (e) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.isComposing &&
      !composing &&
      e.keyCode !== 229
    ) {
      e.preventDefault();
      send();
    }
  };
  $("speakingCharacter").onchange = () => {
    prefs.selected = $("speakingCharacter").value;
    save();
    controls();
  };
  $("favoriteCharacter").onclick = () => {
    prefs.favorites = prefs.favorites.includes(prefs.selected)
      ? prefs.favorites.filter((id) => id !== prefs.selected)
      : [...prefs.favorites, prefs.selected];
    save();
    selectCharacters();
  };
  $("createCharacter").onclick = () => {
    $("newCharacterDialog").showModal();
    $("newCharacterName").focus();
  };
  $("cancelNewCharacter").onclick = () => $("newCharacterDialog").close();
  let createKey, createName;
  $("newCharacterForm").onsubmit = async (event) => {
    event.preventDefault();
    const displayName = $("newCharacterName").value.trim();
    if (!displayName) return;
    if (createName !== displayName) {
      createName = displayName;
      createKey = randomUUID();
    }
    const op = operation;
    $("saveNewCharacter").disabled = true;
    try {
      const result = await client.json(client.room(meta.roomId, "characters"), {
        method: "POST",
        body: { displayName },
        key: createKey,
      });
      if (op !== operation || stopped) return;
      prefs.selected = result.value.id;
      save();
      $("newCharacterDialog").close();
      $("newCharacterName").value = "";
      createName = createKey = undefined;
      await refreshCharacters();
      note("キャラを作成しました。声は「キャラ・声設定」で選べます。");
    } catch (error) {
      if (op === operation) $("newCharacterStatus").textContent = error.message;
    } finally {
      $("saveNewCharacter").disabled = false;
    }
  };
  $("newMessages").onclick = () => {
    $("log").scrollTop = $("log").scrollHeight;
    newCount = 0;
    $("newMessages").hidden = true;
  };
  $("log").onscroll = () => {
    if (
      $("log").scrollHeight - $("log").scrollTop - $("log").clientHeight <
      48
    ) {
      newCount = 0;
      $("newMessages").hidden = true;
    }
  };
  const timer = setInterval(() => {
    if (connected && !stopped) history.sync();
    render();
  }, 15000);
  controls();
  return {
    state,
    render,
    characters(data) {
      characters = data.characters;
      charactersLoaded = true;
      selectCharacters();
    },
    changed() {
      history.sync();
    },
    disconnected() {
      connected = false;
      controls();
    },
    stop() {
      stopped = true;
      connected = false;
      operation++;
      sending = false;
      clearInterval(timer);
      history.stop();
      controls();
    },
  };
}
