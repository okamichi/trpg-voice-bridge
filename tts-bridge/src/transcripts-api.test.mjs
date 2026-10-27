import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "./http.mjs";
import { initialConfig } from "./store.mjs";
for (const enabled of [true, false])
  test(`transcript API authenticates and scopes downloads (${enabled})`, async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "transcript-api-"));
    const initial = initialConfig({});
    initial.provider.type = "mock";
    let capability;
    const app = createApp({
      dataDir,
      initial,
      localOrigin: "http://127.0.0.1:0",
      runtime: {
        settings: { active: { stt: { enabled, logDir: "" } } },
        snapshot: () => ({ stt: { enabled, status: "ready", error: "" } }),
        onSttChange: () => () => {},
      },
      extensions: [
        ({ transcription }) => {
          capability = transcription;
          return { id: "capture", close() {} };
        },
      ],
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = (path, headers = {}, body) =>
      fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const admin = { Authorization: `Bearer ${app.store.secrets.admin}` };
    const invitation = await (
      await request("/api/v1/admin/commands", admin, {
        command: "invite",
        commandId: randomUUID(),
      })
    ).json();
    const invite = new URL(invitation.url).hash.slice(8);
    const joined = await request("/api/v1/join", {}, { invite });
    const cookie = { Cookie: joined.headers.get("set-cookie").split(";")[0] };
    const origin = `chrome-extension://${"a".repeat(32)}`;
    const token = await (
      await request(
        "/api/v1/chatter/join",
        { "X-Chatter-Origin": origin },
        { invite },
      )
    ).json();
    const chatter = {
      Authorization: `Bearer ${token.token}`,
      "X-Chatter-Origin": origin,
    };
    const path = `/api/v1/rooms/${initial.roomId}/transcripts`;
    assert.equal((await request(path)).status, 401);
    assert.equal(
      (await request("/api/v1/rooms/another/transcripts", cookie)).status,
      403,
    );
    for (const headers of [admin, cookie, chatter]) {
      const res = await request(path, headers);
      assert.equal(res.status, enabled ? 200 : 404);
      if (enabled) {
        assert.equal(res.headers.get("content-type"), "application/zip");
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(res.headers.get("x-transcript-count"), "0");
        assert.match(
          res.headers.get("content-disposition"),
          /transcripts-\d{8}-\d{6}\.zip/,
        );
        assert.equal(
          Buffer.from(await res.arrayBuffer()).readUInt32LE(0),
          0x04034b50,
        );
      }
    }
    assert.equal(app.engine.snapshot().transcription.enabled, enabled);
    if (enabled) {
      capability.add({
        time: Date.now(),
        speakerId: "a",
        speakerName: "Alice",
        text: "こんにちは",
        seconds: 1,
      });
      assert.equal(app.engine.snapshot().transcription.count, 1);
      const res = await request(path, cookie);
      assert.equal(res.headers.get("x-transcript-count"), "1");
      assert.ok(
        Buffer.from(await res.arrayBuffer()).includes(
          Buffer.from("こんにちは"),
        ),
      );
    }
  });
