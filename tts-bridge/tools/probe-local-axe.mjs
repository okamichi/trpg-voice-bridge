import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text().slice(0, 250));
});
try {
  await page.goto("http://localhost:4200/", { waitUntil: "domcontentloaded" });
  await page.locator("chat-tab").waitFor({ timeout: 30000 });
  await page.waitForTimeout(12000);
  const state = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll("chat-tab")];
    const row = document.querySelector("chat-message");
    const c = globalThis.ng?.getComponent?.(row);
    const m = c?.chatMessage;
    return {
      title: document.title,
      tabCount: tabs.length,
      rowCount: document.querySelectorAll("chat-message").length,
      ngGetComponent: typeof globalThis.ng?.getComponent,
      firstMessage: m && {
        identifier: m.identifier,
        tabIdentifier: m.tabIdentifier,
        timestamp: m.timestamp,
        isDirect: m.isDirect,
        isSecret: m.isSecret,
        isSystem: m.isSystem,
        name: m.name,
      },
      connectionText: [...document.querySelectorAll("*")]
        .filter(
          (el) =>
            el.children.length === 0 &&
            /^(ID:|接続|Connection|オンライン|Online|Offline|オフライン)/.test(
              el.textContent?.trim() ?? "",
            ),
        )
        .map((el) => el.textContent.trim())
        .slice(0, 12),
      connectionPanel: [...document.querySelectorAll("*")]
        .find(
          (el) => el.children.length === 0 && el.textContent?.trim() === "ID:",
        )
        ?.parentElement?.innerText.slice(0, 250),
    };
  });
  console.log(JSON.stringify({ state, errors: errors.slice(0, 5) }, null, 2));
  assert.match(state.connectionPanel ?? "", /ID:\s*\S{4,}/);
  const channel = await page.evaluate(
    () =>
      globalThis.ng.getComponent(document.querySelector("chat-tab"))?.chatTab
        ?.identifier,
  );
  await page.evaluate((channel) => {
    globalThis.__trpgCollectorSettings = {
      adapter: "udonarium",
      contextId: "axe-probe",
      channel,
    };
    globalThis.__trpgCaptured = [];
    window.addEventListener("message", (e) => {
      if (e.data?.channel === "trpg-voice-collector-v1")
        globalThis.__trpgCaptured.push(e.data);
    });
  }, channel);
  await page.evaluate(
    readFileSync(new URL("../collector/page.js", import.meta.url), "utf8"),
  );
  await page.waitForTimeout(1200);
  const chatInput = page.locator("textarea").last();
  await chatInput.fill("Collector probe first message");
  await chatInput.press("Enter");
  await page.waitForTimeout(500);
  const firstPost = await page.evaluate(() => {
    const row = [...document.querySelectorAll("chat-message")].at(-1);
    const m = globalThis.ng.getComponent(row)?.chatMessage;
    return (
      m && {
        identifier: m.identifier,
        tabIdentifier: m.tabIdentifier,
        timestamp: m.timestamp,
        isDirect: m.isDirect,
        isSecret: m.isSecret,
        isSystem: m.isSystem,
        text: m.text,
        name: m.name,
        sendFrom: m.sendFrom,
      }
    );
  });
  console.log("firstPost", JSON.stringify(firstPost));
  console.log(
    "internals",
    JSON.stringify(
      await page.evaluate(() => {
        const row = [...document.querySelectorAll("chat-message")].at(-1);
        const c = globalThis.ng.getComponent(row);
        const m = c?.chatMessage;
        const tab = globalThis.ng.getComponent(
          document.querySelector("chat-tab"),
        );
        const sender = c?.objectStore?.get(m?.sendFrom);
        return {
          senderConstructor: sender?.constructor?.name,
          senderAlias: sender?.aliasName,
          senderName: sender?.name,
          messageComponentKeys: Object.keys(c ?? {})
            .filter((k) => /store|tab|message/i.test(k))
            .slice(0, 30),
          tabComponentKeys: Object.keys(tab ?? {})
            .filter((k) => /tab|permission/i.test(k))
            .slice(0, 30),
          tab: tab?.chatTab && {
            identifier: tab.chatTab.identifier,
            name: tab.chatTab.name,
            plCanView: tab.chatTab.plCanView,
            guestCanView: tab.chatTab.guestCanView,
            isSystemTab: tab.chatTab.isSystemTab,
          },
        };
      }),
    ),
  );
  await chatInput.fill("Collector probe second message");
  await chatInput.press("Enter");
  await page.waitForTimeout(500);
  const selected = await page.evaluate(() => {
    const input = globalThis.ng.getComponent(
      document.querySelector("chat-input"),
    );
    const character = input?.gameCharacters?.()?.[0];
    if (character) input.sendFrom = character.identifier;
    return character && { id: character.identifier, name: character.name };
  });
  console.log("selected", JSON.stringify(selected));
  if (selected) {
    await chatInput.fill("Collector probe character message");
    await chatInput.press("Enter");
    await page.waitForTimeout(500);
  }
  const captured = await page.evaluate(() => globalThis.__trpgCaptured);
  console.log("collector", JSON.stringify(captured));
  assert.deepEqual(
    captured
      .filter((entry) => entry.type === "event")
      .map((entry) => entry.payload.text),
    ["Collector probe character message"],
  );
} finally {
  await browser.close();
}
