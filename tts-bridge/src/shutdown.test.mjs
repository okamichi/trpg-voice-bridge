import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./http.mjs";
import { initialConfig } from "./store.mjs";

for (const enabled of [true, false]) {
  test(`shutdown capability without runtime: ${enabled}`, async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-shutdown-"));
    const initial = initialConfig({});
    initial.provider.type = "mock";
    let calls = 0;
    const app = createApp({
      dataDir,
      initial,
      localOrigin: "http://127.0.0.1:0",
      ...(enabled ? { onShutdown: () => calls++ } : {}),
    });
    t.after(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}/api/v1/admin/`;
    const headers = {
      Host: "127.0.0.1:0",
      Authorization: `Bearer ${app.store.secrets.admin}`,
      "Content-Type": "application/json",
    };
    const diagnostics = await fetch(base + "diagnostics", { headers });
    assert.equal((await diagnostics.json()).canShutdown, enabled);
    const result = await fetch(base + "shutdown", {
      headers,
      method: "POST",
      body: "{}",
    });
    assert.equal(result.status, enabled ? 200 : 404);
    await new Promise(setImmediate);
    assert.equal(calls, enabled ? 1 : 0);
  });
}
