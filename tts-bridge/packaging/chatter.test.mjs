import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { buildChatter } from "../chatter/build.mjs";

test("Chatter package builds fresh local assets with no development files or remote imports", async (t) => {
  const destination = mkdtempSync(join(tmpdir(), "chatter-assets-"));
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  await buildChatter(destination);
  assert.deepEqual(readdirSync(destination).sort(), [
    "README.md",
    "background.js",
    "manifest.json",
    "panel.html",
    "panel.js",
    "shared",
  ]);
  const html = readFileSync(join(destination, "panel.html"), "utf8");
  assert.match(html, /id="connectionForm"/);
  assert.match(html, /id="chatComposer"/);
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:|\/web\/)/);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g))
    assert.ok(readFileSync(join(destination, match[1])).length);
  for (const name of readdirSync(join(destination, "shared"))) {
    const bytes = readFileSync(join(destination, "shared", name));
    assert.deepEqual(
      bytes,
      readFileSync(new URL(`../web/${name}`, import.meta.url)),
    );
    if (name.endsWith(".js")) {
      for (const match of bytes
        .toString()
        .matchAll(/from\s+["']([^"']+)["']/g)) {
        assert.ok(match[1].startsWith("./"));
        assert.ok(readFileSync(join(destination, "shared", match[1])).length);
      }
    }
  }
  const manifest = JSON.parse(readFileSync(join(destination, "manifest.json")));
  assert.equal(
    manifest.version,
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url)))
      .version,
  );
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.side_panel.default_path, "panel.html");
  assert.deepEqual(manifest.permissions, ["sidePanel", "storage"]);
});

test("version check detects Chatter drift and version command synchronizes both extensions and lockfile", (t) => {
  const root = mkdtempSync(join(tmpdir(), "chatter-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of [
    "packaging/version.mjs",
    "collector/manifest.json",
    "chatter/manifest.json",
    "package.json",
    "package-lock.json",
  ]) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    cpSync(new URL(`../${name}`, import.meta.url), join(root, name));
  }
  const manifest = JSON.parse(
    readFileSync(join(root, "chatter/manifest.json")),
  );
  manifest.version = "0.0.1";
  writeFileSync(join(root, "chatter/manifest.json"), JSON.stringify(manifest));
  const env = { ...process.env, GITHUB_REF_TYPE: "", GITHUB_REF_NAME: "" };
  const args = [join(root, "packaging/version.mjs")];
  assert.equal(
    spawnSync(process.execPath, [...args, "--check"], { env }).status,
    1,
  );
  const pkg = JSON.parse(readFileSync(join(root, "package.json")));
  pkg.version = "1.2.3";
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  execFileSync(process.execPath, args, { env });
  assert.equal(
    execFileSync(process.execPath, [...args, "--check"], {
      env,
      encoding: "utf8",
    }).trim(),
    "1.2.3",
  );
  for (const name of [
    "chatter/manifest.json",
    "collector/manifest.json",
    "package-lock.json",
  ])
    assert.equal(JSON.parse(readFileSync(join(root, name))).version, "1.2.3");
});

test("download ZIP matches disk build and is reproducible by content, with structural build guards", async (t) => {
  const { chatterFiles } = await import("../chatter/files.mjs");
  const { chatterDownload, zipFiles } = await import("../chatter/zip.mjs");
  const { readAsset } = await import("../src/runtime/assets.mjs");
  const { readChatterArchive } = await import("./chatter-archive.mjs");
  const files = chatterFiles(readAsset),
    download = chatterDownload(readAsset);
  assert.deepEqual(download.content, zipFiles(new Map([...files].reverse())));
  const different = new Map(files);
  different.set("README.md", Buffer.from("changed"));
  assert.notDeepEqual(download.content, zipFiles(different));
  assert.equal(
    download.filename,
    `trpg-voice-bridge-chatter-${JSON.parse(readAsset("package.json")).version}.zip`,
  );
  const folder = mkdtempSync(join(tmpdir(), "chatter-zip-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  await buildChatter(folder);
  const extracted = readChatterArchive(download.content);
  assert.deepEqual([...extracted.keys()].sort(), [...files.keys()].sort());
  for (const [name, bytes] of extracted)
    assert.deepEqual(bytes, readFileSync(join(folder, name)));
  assert.match(
    extracted.get("panel.html").toString(),
    /id="connectionAddress"/,
  );
  assert.doesNotMatch(
    extracted.get("panel.html").toString(),
    /id="chatterGuide"/,
  );
  for (const target of [
    "音声・再生設定（クリックで展開）",
    'id="chatterGuide"',
  ])
    assert.throws(
      () =>
        chatterFiles((name) =>
          name === "web/player.html"
            ? Buffer.from(readAsset(name).toString().replace(target, "missing"))
            : readAsset(name),
        ),
      /見出しまたは導入説明/,
    );
});
