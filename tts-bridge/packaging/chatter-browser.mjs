import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

// Run against the extracted SEA and extension, never rebuild or load web/ here.
export async function checkPackagedChatter({
  packageDir,
  temporary,
  base,
  invite,
}) {
  const extension = join(temporary, "配布 Chatter");
  cpSync(join(packageDir, "chatter"), extension, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(extension, "manifest.json")));
  assert.equal(manifest.host_permissions, undefined);
  // Headless Chrome cannot click its native permission prompt. Limit the
  // temporary test copy to this loopback host; shipped files are not changed.
  manifest.host_permissions = [
    `${new URL(base).protocol}//${new URL(base).hostname}/*`,
  ];
  writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(
    mkdtempSync(join(temporary, "browser-")),
    {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    },
  );
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    const errors = [];
    panel.on("pageerror", (e) => errors.push(e.message));
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.locator("#invitation").fill(invite);
    await panel.locator("#joinChatter").click();
    await expect(panel.locator("#status")).toContainText("接続しました");
    const web = await context.newPage();
    web.on("pageerror", (e) => errors.push(e.message));
    await web.goto(invite);
    await expect(web.locator("#status")).toContainText("接続しました");
    await panel.locator("#createCharacter").click();
    await panel.locator("#newCharacterName").fill("配布版の旅人");
    await panel.locator("#saveNewCharacter").click();
    await expect(panel.locator("#speakingCharacter")).not.toHaveValue("");
    await panel.locator("#messageText").fill("同梱Chatterからの発言");
    await panel.locator("#sendMessage").click();
    await expect(web.locator("#log")).toContainText("同梱Chatterからの発言");
    await web
      .locator("#speakingCharacter")
      .selectOption({ label: "配布版の旅人" });
    await web.locator("#messageText").fill("配布版Playerからの返事");
    await web.locator("#sendMessage").click();
    await expect(panel.locator("#log")).toContainText("配布版Playerからの返事");
    await panel.locator("#showSettings").click();
    await expect(panel.getByRole("button", { name: "声を選ぶ" })).toBeVisible();
    await panel.reload();
    await expect(panel.locator("#log li")).toHaveCount(2);
    await expect(panel.locator("#enable")).toHaveText("音声を有効にする");
    await panel.locator("#leaveRoom").click();
    await expect(panel.locator("#connection")).toBeVisible();
    await expect(web.locator("#messageText")).toBeEnabled();
    assert.deepEqual(errors, []);
    console.log(
      "PASS: extracted Chatter and SEA Player share chat without Collector, restore history and leave independently",
    );
  } finally {
    await context.close();
  }
}
