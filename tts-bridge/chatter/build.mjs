import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProjectVersion } from "../packaging/version.mjs";
const source = fileURLToPath(new URL("./", import.meta.url));
// Build into a fresh package directory from an explicit asset list, never by
// copying the developer's generated folder (which may be stale or contain data).
export async function buildChatter(destination = source) {
  checkProjectVersion();
  destination = resolve(destination);
  await mkdir(destination, { recursive: true });
  if (destination !== resolve(source)) {
    for (const name of [
      "manifest.json",
      "background.js",
      "panel.js",
      "README.md",
    ])
      await copyFile(join(source, name), join(destination, name));
  }
  const output = join(destination, "shared");
  await mkdir(output, { recursive: true });
  for (const name of [
    "style.css",
    "player.js",
    "characters.js",
    "playback.js",
    "uuid.js",
    "bridge-client.js",
    "chat-history.js",
    "chat-view.js",
  ]) {
    await writeFile(
      join(output, name),
      await readFile(new URL(`../web/${name}`, import.meta.url)),
    );
  }
  const html = (
    await readFile(new URL("../web/player.html", import.meta.url), "utf8")
  )
    .replace('href="/web/style.css"', 'href="shared/style.css"')
    .replace(
      '<main class="player">',
      `${await readFile(new URL("./connect.html", import.meta.url), "utf8")}\n<main class="player" id="participant" hidden>`,
    )
    .replace("<h1>卓のチャット</h1>", "<h1>Chatter</h1>")
    .replace(
      "<summary>音声・再生設定</summary>",
      '<summary>音声・再生設定</summary><p id="connectionAddress" class="muted"></p>',
    )
    .replace('src="/web/player.js"', 'src="panel.js"')
    .replace(
      'class="secondary">退出</button>',
      'class="secondary">退出・接続先を変更</button>',
    )
    .replace(
      "Discordなどで音声を聞く場合は、",
      "Web Playerと両方で音声を有効にすると二重に再生されます。Discordなどで音声を聞く場合は、",
    );
  await writeFile(join(destination, "panel.html"), html);
  return destination;
}
if (
  process.argv[1] &&
  existsSync(resolve(process.argv[1])) &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  await buildChatter();
  console.log(
    "Chatter: 共通Playerを同梱しました（chatter/ をChromeに読み込めます）",
  );
}
