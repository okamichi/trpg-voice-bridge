// CCFOLIA 1.37.5: read the page's existing store; never dispatch or fetch room data.
(() => {
  if (globalThis.__trpgCcfolia?.version === 1) return;
  const error = (message) => {
    throw new Error(`ココフォリア: ${message}`);
  };
  const str = (value, max = 200) =>
    typeof value === "string" && value.length > 0 && value.length <= max;
  function roomId() {
    const match = /^\/rooms\/([\w-]+)(?:\/chat)?\/?$/.exec(location.pathname);
    if (location.origin !== "https://ccfolia.com" || !match)
      error("ココフォリアの部屋を開いてください");
    return match[1];
  }
  function store() {
    const roots = document.querySelectorAll(
      'ul[role="log"][aria-live="polite"]',
    );
    if (roots.length !== 1) error("ルームチャットを開いてください");
    const root = roots[0];
    let fiber =
      root[Object.keys(root).find((key) => key.startsWith("__reactFiber$"))];
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
      const candidate = fiber.memoizedProps?.value?.store;
      if (
        typeof candidate?.getState === "function" &&
        typeof candidate.subscribe === "function"
      )
        return candidate;
    }
    error("発言IDを取得できません。画面の内部形式が変わった可能性があります");
  }
  function inspect(candidate = store()) {
    const contextId = roomId(),
      state = candidate.getState();
    if (state?.app?.state?.roomId !== contextId)
      error("部屋のチャットのロード完了後に接続してください");
    const room = state.entities?.rooms?.entities?.[contextId];
    const messages = state.entities?.roomMessages?.entities;
    if (
      room?._id !== contextId ||
      !messages ||
      typeof messages !== "object" ||
      Array.isArray(messages) ||
      !Array.isArray(room.messageGroups) ||
      !Array.isArray(room.messageChannels)
    )
      error("部屋・発言・公開タブの形式を確認できません");
    const channels = [
      { id: "main", name: "メイン" },
      { id: "info", name: "情報" },
      { id: "other", name: "雑談" },
    ];
    const ids = new Set(channels.map((channel) => channel.id));
    function add(id, name) {
      if (!str(id, 80) || !str(name) || ids.has(id))
        error("公開タブの識別子を確認できません");
      ids.add(id);
      channels.push({ id, name });
    }
    for (const name of room.messageChannels) add(name, name);
    const groupIds = new Set(ids);
    for (const group of room.messageGroups) {
      if (!str(group?.id, 80) || !["public", "private"].includes(group.kind))
        error("追加タブの公開範囲を確認できません");
      if (groupIds.has(group.id)) error("追加タブの識別子が重複しています");
      groupIds.add(group.id);
      if (group.kind === "public") add(group.id, group.name);
    }
    return { store: candidate, contextId, channels, messages };
  }
  function timestamp(value) {
    if (value === null) return null; // Local write awaiting the server timestamp.
    if (
      !Number.isSafeInteger(value?.seconds) ||
      !Number.isInteger(value.nanoseconds) ||
      value.nanoseconds < 0 ||
      value.nanoseconds >= 1e9
    )
      error("発言の作成日時を確認できません");
    const time = value.seconds * 1000 + Math.floor(value.nanoseconds / 1e6);
    if (!Number.isFinite(new Date(time).getTime()))
      error("発言の作成日時が不正です");
    return time;
  }
  function dialogue(message) {
    if (
      !["text", "system", "note"].includes(message.type) ||
      typeof message.edited !== "boolean" ||
      !(message.to === null || typeof message.to === "string") ||
      !message.extend ||
      typeof message.extend !== "object" ||
      Array.isArray(message.extend)
    )
      error("発言の種別・公開範囲を確認できません");
    if (
      message.to !== null ||
      message.type !== "text" ||
      message.edited ||
      message.removed
    )
      return null;
    // Unknown cards/commands do not become spoken dialogue.
    if (Object.keys(message.extend).some((key) => key !== "roll")) return null;
    if (
      typeof message.text !== "string" ||
      !str(message.name, 100) ||
      !str(message.from, 80)
    )
      error("本文または発言者を確認できません");
    let text = message.text;
    const roll = message.extend.roll;
    if (roll != null) {
      if (typeof roll.secret !== "boolean" || typeof roll.result !== "string")
        error("ダイスの公開範囲を確認できません");
      if (roll.secret) return null;
      // Only a server-recognized roll has its leading command removed. Never
      // append result/dices; ordinary dialogue containing '1D6' is unchanged.
      text = text.replace(/^\s*\S+(?:\s+|$)/u, "");
    }
    text = text.trim();
    if (!text || [...text].length > 500 || /[<>\u0000]/u.test(text))
      return null;
    const identity = JSON.stringify([message.from, message.name]);
    if (!str(identity)) error("発言者の識別子が長すぎます");
    return {
      // CCFOLIA messages carry the sender UID, not a character ID. Namespace
      // this composite identity so one sender can use several character voices.
      speaker: { kind: "character", id: identity, name: message.name },
      text,
    };
  }
  globalThis.__trpgCcfolia = {
    version: 1,
    roomId,
    store,
    inspect,
    timestamp,
    dialogue,
  };
})();
