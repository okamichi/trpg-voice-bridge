import { get } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./http.mjs";
import { readAsset } from "./runtime/assets.mjs";
import { chatterDownload } from "../chatter/zip.mjs";
for (const fails of [false, true])
  test(`Chatter download: Host check, cache and isolated failure (${fails})`, async (t) => {
    let reads = 0;
    const directory = mkdtempSync(join(tmpdir(), "chatter-download-"));
    const app = createApp({
      dataDir: directory,
      localOrigin: "http://127.0.0.1:0",
      chatterAssetReader(name) {
        reads++;
        if (fails) throw new Error("private file path");
        return readAsset(name);
      },
    });
    t.after(async () => {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const startupReads = reads;
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal((await fetch(base + "/player/")).status, 200);
    const denied = await new Promise((resolve, reject) =>
      get(
        base + "/downloads/chatter.zip",
        { headers: { Host: "untrusted.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      ).on("error", reject),
    );
    assert.equal(denied, 403);
    const response = await fetch(base + "/downloads/chatter.zip");
    assert.equal(response.status, fails ? 503 : 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (fails) assert.doesNotMatch(bytes.toString(), /private file path/);
    else {
      const expected = chatterDownload(readAsset);
      assert.equal(
        response.headers.get("content-disposition"),
        `attachment; filename="${expected.filename}"`,
      );
      assert.deepEqual(bytes, expected.content);
      assert.deepEqual(
        Buffer.from(
          await (await fetch(base + "/downloads/chatter.zip")).arrayBuffer(),
        ),
        bytes,
      );
    }
    assert.equal(reads, startupReads);
  });
