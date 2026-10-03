(() => {
  if (globalThis.__trpgRelay) return;
  globalThis.__trpgRelay = true;
  window.addEventListener("message", (e) => {
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
    chrome.runtime
      .sendMessage({ type: d.type, payload: d.payload })
      .catch(() => {});
  });
})();
