import { test, expect, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { initialConfig } from "../src/store.mjs";

// The production contract has no ng.getComponent, no DOM message IDs, and
// no chat-tab.plCanView. Identity and visibility come from the Fly models.
const fixture = `<!doctype html><title>Udonarium with Fly 1.11.2e</title>
<chat-window><chat-tab>公開チャット</chat-tab></chat-window><script>
(() => {
  const registry = new Map();
  const tabs = ['MainTab', 'SubTab'].map((identifier, i) => ({
    identifier, aliasName: 'chat-tab', name: i ? 'サブタブ' : 'メインタブ',
    chatMessages: [], onChildAdded() { window.originalCalls++; },
  }));
  const originalCallback = tabs[0].onChildAdded;
  window.flyCallbackRestored = () => tabs[0].onChildAdded === originalCallback;
  registry.set('ChatTabList', { aliasName: 'chat-tab-list', chatTabs: tabs });
  tabs.forEach(t => registry.set(t.identifier, t));
  registry.set('actor-a', { aliasName: 'character' });
  window.originalCalls = 0;
  window.currentTab = 'MainTab';
  document.querySelector('chat-window').addEventListener('mousemove', () => registry.get(currentTab));
  window.addFlyMessage = (overrides = {}, channel = 'MainTab') => {
    const tab = registry.get(channel), m = {
      aliasName: 'chat', identifier: crypto.randomUUID(), timestamp: Date.now(),
      tabIdentifier: channel, name: 'キャラA', characterIdentifier: 'actor-a', text: 'こんにちは',
      isDirect: false, isSecret: false, isSystem: false, isDicebot: false, isOperationLog: false,
      sendTo: [], ...overrides,
    };
    tab.chatMessages.push(m); tab.onChildAdded(m); return m.identifier;
  };
  addFlyMessage({ text: '接続前の履歴', timestamp: Date.now() + 60000 });
})();</script>`;

test("Fly extension auto-detection, manual selection and original message IDs reach Bridge", async () => {
  const config = initialConfig({});
  config.provider.type = "mock";
  const app = createApp({
    dataDir: mkdtempSync(join(tmpdir(), "trpg-fly-")),
    initial: config,
    localOrigin: "http://127.0.0.1:0",
  });
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(fixture);
  });
  let context;
  try {
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    app.engine.accepting = true;
    const extension = new URL("../collector", import.meta.url).pathname;
    context = await chromium.launchPersistentContext(
      mkdtempSync(join(tmpdir(), "trpg-fly-chrome-")),
      {
        channel: "chromium",
        headless: true,
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      },
    );
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const vtt = await context.newPage();
    await vtt.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const reopen = async () => {
      await popup.evaluate(async () => {
        const tab = (await chrome.tabs.query({})).find((t) =>
          t.url?.endsWith("/fixture"),
        );
        await chrome.tabs.update(tab.id, { active: true });
      });
      await popup.reload();
    };
    await reopen();
    await expect(popup.locator("#detected")).toContainText("with Fly");
    await expect(popup.locator("[name=channelChoice]")).toHaveValue("MainTab");
    await expect(popup.locator("#channelField")).not.toBeVisible();
    await expect(popup.locator("[name=channelChoice] option")).toHaveText([
      "メインタブ (MainTab)",
      "サブタブ (SubTab)",
    ]);
    await popup.locator("[name=contextId]").fill("fly-room");
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
    expect(app.store.config.characters).toHaveLength(0);
    const id = await vtt.evaluate(() => {
      for (const overrides of [
        { isDirect: true },
        { isSecret: true },
        { isSystem: true },
        { isOperationLog: true },
        { sendTo: ["someone"] },
        { characterIdentifier: "" },
        { timestamp: 1 },
      ])
        addFlyMessage(overrides);
      addFlyMessage({}, "SubTab");
      return addFlyMessage();
    });
    await expect.poll(() => app.store.config.characters.length).toBe(1);
    expect(app.store.config.characters[0].bindings[0].speakerId).toBe(
      "actor-a",
    );
    expect(app.store.maxSeq()).toBe(1);
    expect(app.store.db.prepare("SELECT key FROM events").get().key).toContain(
      id,
    );
    await popup.getByRole("button", { name: "取得を停止" }).click();
    await expect(popup.locator("#status")).toContainText("停止しました");
    expect(app.engine.collectors.size).toBe(0);
    expect(await vtt.evaluate(() => flyCallbackRestored())).toBe(true);
    // A deployment with a changed title can be explicitly selected as Fly.
    await vtt.evaluate(() => {
      document.title = "Custom VTT";
    });
    await reopen();
    await expect(popup.locator("#detected")).toContainText("ユドナリウム / ");
    await popup.locator("[name=mode]").selectOption("fly");
    await expect(popup.locator("#detected")).toContainText("with Fly");
    await reopen();
    await expect(popup.locator("[name=mode]")).toHaveValue("fly");
    await expect(popup.locator("#detected")).toContainText("with Fly");
    // A non-displayed target fails concretely and releases the Bridge lease.
    await popup.locator("[name=channelChoice]").selectOption("SubTab");
    await popup.getByRole("button", { name: "このタブを接続" }).click();
    await expect(popup.locator("#status")).toContainText("SubTab");
    await expect.poll(() => app.engine.collectors.size).toBe(0);
    expect(
      await vtt.evaluate(() =>
        Map.prototype.get.toString().includes("[native code]"),
      ),
    ).toBe(true);
  } finally {
    await context?.close();
    if (server.listening) await new Promise((r) => server.close(r));
    await app.close();
  }
});
