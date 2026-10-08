(() => {
  globalThis.__trpgRelayStop?.();
  globalThis.__trpgRelay = true;
  const relay = (e) => {
    if (
      e.source !== window ||
      e.origin !== location.origin ||
      e.data?.channel !== "trpg-voice-collector-v1"
    )
      return;
    const d = e.data;
    if (
      !["event", "diagnostic"].includes(d.type) ||
      JSON.stringify(d).length > 14000
    )
      return;
    // No secret is ever sent to MAIN world or injected into the VTT DOM.
    try {
      if (chrome.runtime?.id)
        chrome.runtime
          .sendMessage({ type: d.type, payload: d.payload })
          .catch(() => {});
    } catch {
      /* Extension was reloaded; this document must reconnect. */
    }
  };
  window.addEventListener("message", relay);
  globalThis.__trpgRelayStop = () =>
    window.removeEventListener("message", relay);
})();
