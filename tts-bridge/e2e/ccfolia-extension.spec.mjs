import { test, expect, chromium } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { initialConfig } from "../src/store.mjs";

// Observed CCFOLIA 1.37.5 contract: no DOM message IDs; Provider store is
// reachable even in an empty virtualized chat. No real room/network is used.
const fixture = `<!doctype html><meta charset="utf-8"><title>CCFOLIA contract fixture</title>
<ul role="log" aria-live="polite" aria-label="ルームチャット"></ul><script>
window.ccStamp = (time = Date.now()) => ({ seconds: Math.floor(time / 1000), nanoseconds: (time % 1000) * 1e6 });
let state = {
  app: { state: { roomId: 'room', roomChatTab: 'other', roomChatInitialized: false } },
  entities: {
    rooms: { entities: { room: { _id: 'room', messageChannels: [], messageGroups: [
      { id: 'public-id', name: '作成タブ', kind: 'public' },
      { id: 'private-id', name: '秘密タブ', kind: 'private' },
    ] } } },
    roomMessages: { entities: {} },
  },
};
const listeners = new Set();
const store = { getState: () => state, subscribe: f => { listeners.add(f); return () => listeners.delete(f); } };
window.ccListeners = () => listeners.size;
window.ccNotify = () => [...listeners].forEach(f => f());
window.ccAdd = (extra = {}) => {
  const m = { _id: crypto.randomUUID(), from: 'sender-a', name: 'メリッサ', text: 'こんにちは',
    type: 'text', channel: 'main', to: null, toName: '', edited: false, extend: {},
    createdAt: ccStamp(), updatedAt: ccStamp(), ...extra };
  state = { ...state, entities: { ...state.entities, roomMessages: {
    entities: { ...state.entities.roomMessages.entities, [m._id]: m },
  } } }; ccNotify(); return m._id;
};
window.ccUpdate = (id, extra) => ccAdd({ ...state.entities.roomMessages.entities[id], ...extra, _id: id });
window.ccPrivatize = () => {
  state = { ...state, entities: { ...state.entities, rooms: { entities: { room: {
    ...state.entities.rooms.entities.room, messageGroups: [{ id: 'public-id', name: '作成タブ', kind: 'private' }],
  } } } } }; ccNotify();
};
const provider = { memoizedProps: { value: { store } }, return: null };
document.querySelector('ul').__reactFiber$fixture = { memoizedProps: {}, return: provider };
</script>`;

test("CCFOLIA defaults to main, selects public IDs, filters dice/privacy and releases its subscription", async () => {
  test.setTimeout(60000);
  const work = new URL("../../tmp/", import.meta.url).pathname;
  mkdirSync(work, { recursive: true });
  const config = initialConfig({});
  config.provider.type = "mock";
  const app = createApp({
    dataDir: mkdtempSync(join(work, "ccfolia-data-")),
    initial: config,
    localOrigin: "http://127.0.0.1:0",
  });
  const received = [];
  const ingress = app.engine.ingress.bind(app.engine);
  app.engine.ingress = (event, collectorId) => {
    received.push(structuredClone(event));
    return ingress(event, collectorId);
  };
  let context;
  try {
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    app.engine.accepting = true;
    // Opening popup.html directly in headless Chrome does not grant activeTab.
    // Grant the routed fixture origin ONLY in a disposable copy of the extension.
    const extension = mkdtempSync(join(work, "ccfolia-extension-"));
    cpSync(new URL("../collector", import.meta.url), extension, {
      recursive: true,
    });
    const manifestPath = join(extension, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.host_permissions.push("https://ccfolia.com/*");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(
      mkdtempSync(join(work, "ccfolia-chrome-")),
      {
        channel: "chromium",
        headless: true,
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      },
    );
    await context.route("https://ccfolia.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: fixture }),
    );
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const vtt = await context.newPage();
    await vtt.goto("https://ccfolia.com/rooms/room");
    // Initial history is excluded even with a future timestamp.
    await vtt.evaluate(() =>
      ccAdd({ text: "接続前", createdAt: ccStamp(Date.now() + 60000) }),
    );
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const reopen = async () => {
      await popup.evaluate(async () => {
        const tab = (await chrome.tabs.query({})).find(
          (t) => t.url === "https://ccfolia.com/rooms/room",
        );
        await chrome.tabs.update(tab.id, { active: true });
      });
      await popup.reload();
      await expect(popup.locator("#detected")).toHaveText(
        "ココフォリア / room",
      );
    };
    await reopen();
    await expect(popup.locator("[name=mode]")).toHaveValue("auto");
    await expect(popup.locator("[name=channelChoice]")).toHaveValue("main");
    await expect(popup.locator("[name=channelChoice] option")).toHaveText([
      "メイン",
      "情報",
      "雑談",
      "作成タブ",
    ]);
    await popup.locator("[name=mode]").selectOption("ccfolia");
    await expect(popup.locator("[name=channelChoice]")).toHaveValue("main");
    await popup.getByText("Bridge接続先", { exact: true }).click();
    await popup
      .locator("[name=bridge]")
      .fill(`http://127.0.0.1:${app.server.address().port}`);
    await popup.getByRole("button", { name: "このタブを接続" }).click();
    await expect(popup.locator("#status")).toContainText("確認コード:");
    const admin = await context.newPage();
    await admin.goto(app.adminUrl());
    await expect(admin.locator("#pairings")).not.toBeEmpty();
    await admin.getByRole("button", { name: "承認", exact: true }).click();
    await expect(admin.locator("#pairingSection")).not.toBeVisible();
    await reopen();
    await popup.getByRole("button", { name: "このタブを接続" }).click();
    await expect(popup.locator("#status")).toContainText("接続しました");
    expect(app.store.maxSeq()).toBe(0);
    expect(await vtt.evaluate(() => ccListeners())).toBe(1);
    const pending = await vtt.evaluate(() =>
      ccAdd({ createdAt: null, updatedAt: null }),
    );
    expect(app.store.maxSeq()).toBe(0);
    await vtt.evaluate(
      (id) => ccUpdate(id, { createdAt: ccStamp(), updatedAt: ccStamp() }),
      pending,
    );
    await expect.poll(() => app.store.maxSeq()).toBe(1);
    expect(app.store.config.characters[0].bindings[0].speakerId).toBe(
      JSON.stringify(["sender-a", "メリッサ"]),
    );
    await vtt.evaluate((id) => {
      ccUpdate(id, { text: "編集したセリフ", edited: true });
      for (const extra of [
        { to: "recipient" },
        { channel: "private-id" },
        { channel: "unknown-id" },
        { channel: "info" },
        { type: "system" },
        { type: "note" },
        { removed: true },
        { createdAt: ccStamp(1) },
        { extend: { unknownCard: true } },
        {
          text: "1D6",
          extend: { roll: { secret: false, result: "(1D6) ＞ 4" } },
        },
        {
          text: "天候表",
          extend: { roll: { secret: false, result: "晴れ" } },
        },
        {
          text: "s1D6 内緒",
          extend: { roll: { secret: true, result: "???" } },
        },
      ])
        ccAdd(extra);
      ccAdd({
        text: "1D100 ダイスを振ったわ！",
        extend: { roll: { secret: false, result: "(1D100) ＞ 95" } },
      });
      ccAdd({ text: "ここに1D6と書いても普通のセリフ" });
      ccAdd({ name: "男の子" });
      ccAdd({ from: "sender-b" });
    }, pending);
    await expect.poll(() => app.store.maxSeq()).toBe(5);
    expect(app.store.config.characters).toHaveLength(3);
    const dialogue = received.map((event) => event.text);
    expect(dialogue).toContain("ダイスを振ったわ！");
    expect(dialogue.some((text) => /95|編集した/u.test(text ?? ""))).toBe(
      false,
    );
    await popup.getByRole("button", { name: "取得を停止" }).click();
    await expect(popup.locator("#status")).toContainText("停止しました");
    expect(await vtt.evaluate(() => ccListeners())).toBe(0);
    expect(app.engine.collectors.size).toBe(0);
    // Public tab names are displayed, but only their stable IDs are saved.
    await popup.locator("[name=channelChoice]").selectOption("public-id");
    await popup.getByRole("button", { name: "このタブを接続" }).click();
    await expect(popup.locator("#status")).toContainText("接続しました");
    expect(
      await popup.evaluate(
        async () =>
          (await chrome.storage.session.get("active")).active.settings.channel,
      ),
    ).toBe("public-id");
    await vtt.evaluate(() => {
      ccAdd();
      ccAdd({ channel: "public-id", text: "公開サブタブ" });
    });
    await expect.poll(() => app.store.maxSeq()).toBe(6);
    await vtt.evaluate(() => {
      ccPrivatize();
      ccAdd({ channel: "public-id", text: "非公開になったタブ" });
    });
    await expect(popup.locator("#status")).toContainText("公開ではありません");
    expect(await vtt.evaluate(() => ccListeners())).toBe(0);
    expect(app.store.maxSeq()).toBe(6);
    await popup.getByRole("button", { name: "取得を停止" }).click();
    // Closing/reopening the popup and explicit detection both reset to main.
    await reopen();
    await expect(popup.locator("[name=channelChoice]")).toHaveValue("main");
    await expect(popup.locator("[name=channelChoice] option")).toHaveText([
      "メイン",
      "情報",
      "雑談",
    ]);
  } finally {
    await context?.close();
    await app.close();
  }
});
