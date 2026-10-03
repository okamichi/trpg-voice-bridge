import { test, expect, chromium } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http.mjs";
import { initialConfig } from "../src/store.mjs";
test("MV3 extension connects through isolated relay; stop releases collector lease", async () => {
  const c = initialConfig(
    JSON.parse(readFileSync(new URL("../profiles.json", import.meta.url))),
  );
  c.provider.type = "mock";
  c.sources = [{ adapter: "fvtt", instanceId: "vtt", contextId: "world" }];
  c.characters[0].bindings = [{ ...c.sources[0], speakerId: "actor" }];
  const app = createApp({
    dataDir: mkdtempSync(join(tmpdir(), "trpg-ext-")),
    initial: c,
    localOrigin: "http://127.0.0.1:0",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  app.engine.accepting = true;
  const fixture = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><title>FVTT contract fixture</title><h1>Fixture only</h1>",
    );
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  let context;
  try {
    const extension = new URL("../collector", import.meta.url).pathname;
    context = await chromium.launchPersistentContext(
      mkdtempSync(join(tmpdir(), "trpg-chrome-")),
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
    await vtt.goto(`http://127.0.0.1:${fixture.address().port}/fixture`);
    await vtt.evaluate(() => {
      window.game = {
        version: "14.365",
        ready: true,
        world: { id: "world" },
        system: { id: "fixture", version: "1" },
      };
      window.CONST = { CHAT_MESSAGE_STYLES: { IC: 2 } };
      window.hooks = {};
      window.Hooks = {
        on: (n, f) => {
          hooks[n] = f;
          return n;
        },
        off: (n) => delete hooks[n],
      };
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const settings = {
      bridge: `http://127.0.0.1:${app.server.address().port}`,
      token: app.store.secrets.collector,
      adapter: "fvtt",
      instanceId: "vtt",
      contextId: "world",
      channel: "main",
    };
    const response = await popup.evaluate(async (settings) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((x) => x.url?.endsWith("/fixture"));
      return chrome.runtime.sendMessage({
        type: "connect",
        settings,
        tabId: tab.id,
      });
    }, settings);
    expect(response.error).toBeUndefined();
    await expect
      .poll(() => vtt.evaluate(() => typeof hooks.createChatMessage))
      .toBe("function");
    await vtt.evaluate(() =>
      hooks.createChatMessage({
        id: "new",
        timestamp: Date.now(),
        whisper: [],
        blind: false,
        rolls: [],
        isRoll: false,
        style: 2,
        speaker: { actor: "actor", alias: "メリッサ" },
        alias: "メリッサ",
        content: "<p>冒険を始めましょう。</p>",
      }),
    );
    await expect
      .poll(() => [...app.engine.orders.values()].map((o) => o.status))
      .toEqual(["ready"]);
    expect(
      await vtt.evaluate(() => JSON.stringify(window.__trpgCollectorSettings)),
    ).not.toContain(settings.token);
    expect(
      (await popup.evaluate(() => chrome.runtime.sendMessage({ type: "stop" })))
        .error,
    ).toBeUndefined();
    expect(app.engine.collectors.size).toBe(0);
    const again = await popup.evaluate(async (settings) => {
      const tab = (await chrome.tabs.query({})).find((x) =>
        x.url?.endsWith("/fixture"),
      );
      return chrome.runtime.sendMessage({
        type: "connect",
        settings,
        tabId: tab.id,
      });
    }, settings);
    expect(again.error).toBeUndefined();
  } finally {
    await context?.close();
    await new Promise((r) => fixture.close(r));
    await app.close();
  }
});
