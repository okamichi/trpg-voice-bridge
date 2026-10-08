// Fly's production build keeps its ObjectStore, but removes Angular debug APIs.
// Observe one normal lookup briefly to obtain the original, stable model IDs.
// Never inspect the contents of other tabs or enumerate the object registry.
(() => {
  if (globalThis.__trpgFly?.version === 1) return;
  let cancel;
  globalThis.__trpgFly = {
    version: 1,
    cancel: () => cancel?.(),
    capture(channel = "") {
      cancel?.();
      return new Promise((resolve, reject) => {
        const descriptor = Object.getOwnPropertyDescriptor(
            Map.prototype,
            "get",
          ),
          original = descriptor.value;
        let finished = false,
          timer;
        const restore = () => {
          finished = true;
          clearTimeout(timer);
          if (Map.prototype.get === tap)
            Object.defineProperty(Map.prototype, "get", descriptor);
          if (cancel === abort) cancel = null;
        };
        const abort = () => {
          restore();
          reject(new Error("Flyの取得を中断しました"));
        };
        function tap(key) {
          const value = original.call(this, key);
          if (!finished && typeof key === "string") {
            try {
              if (
                value?.aliasName === "chat-tab" &&
                value.identifier === key &&
                (!channel || key === channel)
              ) {
                const list = original.call(this, "ChatTabList");
                if (
                  list?.aliasName === "chat-tab-list" &&
                  Array.isArray(list.chatTabs) &&
                  list.chatTabs.includes(value) &&
                  Array.isArray(value.chatMessages)
                ) {
                  const registry = this;
                  restore();
                  resolve({
                    tab: value,
                    list,
                    get: (id) => original.call(registry, id),
                  });
                }
              }
            } catch {
              /* A foreign Map lookup must keep its original behavior. */
            }
          }
          return value;
        }
        cancel = abort;
        Object.defineProperty(Map.prototype, "get", {
          ...descriptor,
          value: tap,
        });
        timer = setTimeout(() => {
          restore();
          reject(
            new Error(
              channel
                ? `Flyの対象チャット「${channel}」を開いて、もう一度接続してください`
                : "Flyのチャット画面を開いて、もう一度確認してください",
            ),
          );
        }, 3000);
        // A mouse move requests Fly's normal view update without sending a chat,
        // changing tabs, focus, scroll position, or game data.
        const root =
          document.querySelector("chat-window") ??
          document.querySelector("chat-tab");
        root?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      });
    },
  };
})();
