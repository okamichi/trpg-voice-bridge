// Injected on explicit tab selection. No credentials or bridge addresses in this world.
(() => {
  globalThis.__trpgCollectorStop?.();
  let stopped = false,
    cleanup = () => {},
    seen = new Set();
  const connectedAt = Date.now(),
    settings = globalThis.__trpgCollectorSettings;
  const emit = (type, payload) =>
    window.postMessage(
      { channel: "trpg-voice-collector-v1", type, payload },
      location.origin,
    );
  const fail = (reason) => {
    if (stopped) return;
    stopped = true;
    cleanup();
    emit("diagnostic", reason);
  };
  globalThis.__trpgCollectorStop = () => {
    stopped = true;
    cleanup();
  };
  function send(data) {
    if (stopped || seen.has(data.messageId)) return;
    seen.add(data.messageId);
    if (seen.size > 20000)
      return fail("発言数の上限に達しました。再接続してください");
    emit("event", data);
  }
  function plain(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (
      doc.querySelector(
        ".secret,[data-visibility],.whisper,.blind,script,iframe,object,embed,form,style,.dice-roll,.chat-card,.item-card",
      )
    )
      return null;
    // Text formatting and links only. Unknown system cards fail closed.
    if (
      [...doc.body.querySelectorAll("*")].some(
        (el) =>
          ![
            "P",
            "DIV",
            "SPAN",
            "BR",
            "STRONG",
            "B",
            "I",
            "EM",
            "U",
            "S",
            "A",
            "BLOCKQUOTE",
          ].includes(el.tagName),
      )
    )
      return null;
    for (const br of doc.querySelectorAll("br")) br.replaceWith("\n");
    return doc.body.textContent
      .replace(/\[\[[\s\S]*?\]\]/g, "")
      .replace(/@(?:UUID|Actor|Item)\[[^\]]*\](?:\{([^}]*)\})?/g, "$1")
      .trim();
  }
  if (settings.adapter === "fvtt") {
    const major = Number(String(globalThis.game?.version ?? "").split(".")[0]);
    if (
      ![12, 13, 14].includes(major) ||
      !globalThis.Hooks?.on ||
      !globalThis.game?.ready
    )
      return fail(
        "FVTT 12/13/14のロード完了したワールドが必要です。その他の版は検証待ちです",
      );
    if (game.world?.id !== settings.contextId)
      return fail("ワールドが変わりました。拡張から再接続してください");
    const ic = globalThis.CONST?.CHAT_MESSAGE_STYLES?.IC;
    if (typeof ic !== "number") return fail("FVTTのIC発言種別を確認できません");
    const hook = Hooks.on("createChatMessage", (m) => {
      if (stopped) return;
      if (
        !Array.isArray(m.whisper) ||
        typeof m.blind !== "boolean" ||
        !Array.isArray(m.rolls)
      )
        return fail("FVTTの公開範囲の形式が変わりました。取得を停止しました");
      if (
        m.whisper.length ||
        m.blind ||
        m.rolls.length ||
        m.isRoll ||
        m.style !== ic ||
        !m.speaker?.actor
      )
        return;
      if (
        typeof m.id !== "string" ||
        typeof m.content !== "string" ||
        typeof m.timestamp !== "number"
      )
        return fail("FVTTの発言形式を確認できません");
      const text = plain(m.content);
      if (!text || [...text].length > 500) return;
      send({
        messageId: m.id,
        contextId: game.world.id,
        speaker: {
          kind: "character",
          id: m.speaker.actor,
          name: m.alias ?? m.speaker.alias ?? m.speaker.actor,
          tokenId: m.speaker.token ?? undefined,
          sceneId: m.speaker.scene ?? undefined,
        },
        text,
        occurredAt: new Date(m.timestamp).toISOString(),
        channel: "main",
      });
    });
    cleanup = () => Hooks.off("createChatMessage", hook);
    emit(
      "diagnostic",
      `FVTT ${game.version} / system ${game.system?.id} ${game.system?.version} / adapter 0.1 / 新規IC公開発言のみ`,
    );
  } else if (settings.adapter === "udonarium") {
    // The official DOM has only minute-resolution timestamps and virtualized rows.
    // Never invent stable IDs from text. A readable Angular component is required.
    const component = (el) => {
      if (globalThis.ng?.getComponent) {
        try {
          return ng.getComponent(el);
        } catch {}
      }
      return null;
    };
    const roots = [...document.querySelectorAll("chat-tab")].filter(
      (el) => el.getClientRects().length,
    );
    if (roots.length !== 1)
      return fail("表示中のユドナリウムのチャットタブを一つにしてください");
    const root = roots[0],
      rows = [...root.querySelectorAll("chat-message")];
    if (
      !rows.length ||
      !rows.every((el) => component(el)?.chatMessage?.identifier)
    )
      return fail(
        "このユドナリウムでは発言IDを安全に取得できません。DOMは仮想化され、履歴との識別が未解決のため取得を停止しました",
      );
    const tab = component(root)?.chatTab;
    if (
      typeof tab?.identifier !== "string" ||
      typeof tab.plCanView !== "boolean" ||
      typeof tab.guestCanView !== "boolean" ||
      typeof tab.isSystemTab !== "boolean"
    )
      return fail("対象タブの公開範囲を確認できません");
    if (!tab.plCanView || !tab.guestCanView || tab.isSystemTab)
      return fail("対象タブが全員公開ではありません。取得を停止しました");
    const tabId = tab.identifier;
    if (settings.channel !== tabId)
      return fail(
        `対象チャット欄にはtabIdentifierを指定してください: ${tabId}`,
      );
    for (const el of rows) seen.add(component(el).chatMessage.identifier);
    const scan = () => {
      if (!root.isConnected || !root.getClientRects().length)
        return fail("タブが切り替わりました。対象を確認して再接続してください");
      if (
        component(root)?.chatTab !== tab ||
        !tab.plCanView ||
        !tab.guestCanView ||
        tab.isSystemTab
      )
        return fail("対象タブが全員公開ではありません。取得を停止しました");
      for (const el of root.querySelectorAll("chat-message")) {
        const m = component(el)?.chatMessage;
        if (
          !m ||
          typeof m.identifier !== "string" ||
          typeof m.timestamp !== "number"
        )
          return fail("発言IDまたは時刻の判定に失敗しました");
        if (seen.has(m.identifier) || m.timestamp <= connectedAt) continue;
        if (m.tabIdentifier !== tabId)
          return fail("対象タブの判定に失敗しました");
        if (
          typeof m.isDirect !== "boolean" ||
          typeof m.isSecret !== "boolean" ||
          typeof m.isSystem !== "boolean" ||
          typeof m.isDicebot !== "boolean" ||
          typeof m.isOutOfStory !== "boolean"
        )
          return fail("公開範囲の判定に失敗しました");
        if (
          m.isDirect ||
          m.isSecret ||
          m.isSystem ||
          m.isDicebot ||
          m.isOutOfStory ||
          m.isSystemMessage ||
          m.isSystemToPL
        ) {
          seen.add(m.identifier);
          continue;
        }
        if (typeof m.text !== "string" || typeof m.name !== "string")
          return fail("本文または話者を抽出できません");
        const sender = component(el)?.objectStore?.get(m.sendFrom);
        if (!sender || typeof sender.aliasName !== "string")
          return fail("話者種別を確認できません");
        if (sender.aliasName !== "character") {
          seen.add(m.identifier);
          continue;
        }
        send({
          messageId: m.identifier,
          contextId: settings.contextId,
          speaker: { kind: "character", id: m.sendFrom, name: m.name },
          text: m.text,
          occurredAt: new Date(m.timestamp).toISOString(),
          channel: "main",
        });
      }
    };
    const observer = new MutationObserver(() => queueMicrotask(scan));
    observer.observe(root, { childList: true, subtree: true });
    const timer = setInterval(scan, 1000);
    cleanup = () => {
      observer.disconnect();
      clearInterval(timer);
    };
    emit(
      "diagnostic",
      "ユドナリウム実験用 / 全員公開タブの新規キャラ発言のみ / キャラIDを使用。公開ビルド未検証",
    );
  } else if (settings.adapter === "ccfolia") {
    fail(
      "ココフォリア: 元発言ID・公開/秘匿/グループ範囲・新着判定の実機検証待ちです。本文は送信していません",
    );
  } else fail("未対応のツールです");
})();
