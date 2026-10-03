const form = document.getElementById("settings"),
  status = document.getElementById("status");
chrome.storage.session
  .get(["settings", "diagnostic"])
  .then(({ settings, diagnostic }) => {
    if (settings)
      for (const [k, v] of Object.entries(settings))
        if (form.elements[k]) form.elements[k].value = v;
    status.textContent = diagnostic ?? "未接続";
  });
form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    const settings = Object.fromEntries(new FormData(form));
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const result = await chrome.runtime.sendMessage({
      type: "connect",
      settings,
      tabId: tab.id,
    });
    status.textContent =
      result.error ?? "接続しました。管理画面で読み上げを開始してください。";
  } catch (e) {
    status.textContent = e.message;
  }
};
document.getElementById("stop").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "stop" });
  status.textContent = "停止しました";
};
