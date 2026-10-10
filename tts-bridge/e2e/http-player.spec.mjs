import { test, expect, chromium } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { createApp } from "../src/http.mjs";
import { initialConfig } from "../src/store.mjs";

test("public HTTP through a TCP forwarder supports joining, voice editing and playback", async () => {
  let app, browser;
  const sockets = new Set();
  // Preserve HTTP Host, Origin and WebSocket bytes, just like socat.
  const proxy = createServer((client) => {
    const upstream = connect(app.server.address().port, "127.0.0.1");
    sockets.add(client);
    sockets.add(upstream);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const publicOrigin = `http://bridge.test:${proxy.address().port}`;
    const config = initialConfig(
      JSON.parse(readFileSync(new URL("../profiles.json", import.meta.url))),
    );
    config.provider.type = "mock";
    const source = {
      adapter: "fixture",
      instanceId: "http",
      contextId: "room",
    };
    config.sources = [source];
    config.characters[0].bindings = [{ ...source, speakerId: "melissa" }];
    const characterId = config.characters[0].id;
    app = createApp({
      dataDir: mkdtempSync(join(tmpdir(), "trpg-http-")),
      initial: config,
      localOrigin: "http://127.0.0.1:0",
      publicOrigin,
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    app.engine.connect({ source, collectorId: "collector" });
    app.engine.accepting = true;
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const inviteResponse = await fetch(base + "/api/v1/admin/commands", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${app.store.secrets.admin}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command: "invite", commandId: "http-invite" }),
    });
    expect(inviteResponse.ok).toBeTruthy();
    const invite = await inviteResponse.json();
    expect(invite.url.startsWith(publicOrigin + "/player/")).toBeTruthy();
    browser = await chromium.launch({
      args: [
        "--host-resolver-rules=MAP bridge.test 127.0.0.1",
        "--no-proxy-server",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.started = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (raw) {
        const message = JSON.parse(raw);
        if (message.type === "playback.started")
          window.started.push(message.orderId);
        return send.call(this, raw);
      };
    });
    await page.goto(invite.url);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe(
      "undefined",
    );
    await expect(page.locator("#status")).toContainText("接続しました");
    expect(new URL(page.url()).hash).toBe("");
    expect(
      (await context.cookies()).find((cookie) => cookie.name === "trpg_player")
        ?.secure,
    ).toBe(false);

    await page.getByRole("button", { name: "音声を有効にする" }).click();
    await page
      .locator("#characters .list-item")
      .filter({ hasText: "メリッサ" })
      .getByRole("button", { name: "試聴・変更" })
      .click();
    await page.getByRole("button", { name: "自分だけで試聴" }).click();
    await expect(page.locator("#editorStatus")).toContainText(
      "あなたにだけ再生",
    );
    await page.getByLabel("キャラ名", { exact: true }).fill("HTTPのメリッサ");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator("#characterEditor")).not.toBeVisible();
    await expect(page.locator("#characters")).toContainText("HTTPのメリッサ");
    expect(
      app.store.config.characters.find((c) => c.id === characterId).displayName,
    ).toBe("HTTPのメリッサ");

    const result = app.engine.ingress(
      {
        schemaVersion: 1,
        eventId: "http-event",
        roomId: app.engine.config.roomId,
        sessionId: app.engine.sessionId,
        source: { ...source, messageId: "http-message", revision: 0 },
        speaker: { kind: "character", id: "melissa", name: "HTTPのメリッサ" },
        kind: "dialogue",
        visibility: "public",
        channel: "main",
        text: "HTTPでも聞こえます。",
        occurredAt: new Date().toISOString(),
      },
      "collector",
    );
    await expect
      .poll(() => page.evaluate(() => window.started))
      .toEqual([result.orderId]);
    await expect(page.locator("#log")).toContainText("HTTPでも聞こえます。");
    const voicesBeforeDelete = structuredClone(app.store.config.voiceProfiles);
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .locator("#characters .list-item")
      .filter({ hasText: "HTTPのメリッサ" })
      .getByRole("button", { name: "削除", exact: true })
      .click();
    await expect(
      page
        .locator("#characters .list-item")
        .filter({ hasText: "HTTPのメリッサ" }),
    ).toHaveCount(0);
    expect(app.store.config.characters.some((c) => c.id === characterId)).toBe(
      false,
    );
    expect(app.store.config.voiceProfiles).toEqual(voicesBeforeDelete);
    // The public URL still cannot expose the local-only management interface.
    const deniedStatus = await page.evaluate(
      async () => (await fetch("/admin/")).status,
    );
    expect(deniedStatus).toBe(403);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
    await app?.close();
  }
});
