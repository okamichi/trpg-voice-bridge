// Explicit, shared asset list for disk builds and the runtime download.
export const chatterAssets = [
  "manifest.json",
  "background.js",
  "panel.js",
  "connect.html",
  "README.md",
];
export function chatterFiles(read) {
  const files = new Map();
  for (const name of chatterAssets.filter((name) => name !== "connect.html"))
    files.set(name, Buffer.from(read(`chatter/${name}`)));
  for (const name of [
    "style.css",
    "player.js",
    "characters.js",
    "playback.js",
    "uuid.js",
    "bridge-client.js",
    "chat-history.js",
    "chat-view.js",
  ])
    files.set(`shared/${name}`, Buffer.from(read(`web/${name}`)));
  const player = read("web/player.html").toString();
  if (
    !player.includes("<summary>音声・再生設定（クリックで展開）</summary>") ||
    !/<details id="chatterGuide">[\s\S]*?<\/details>/.test(player)
  )
    throw new Error("Chatter: Playerの見出しまたは導入説明がありません");
  let html = player
    .replace(/<details id="chatterGuide">[\s\S]*?<\/details>/, "")
    .replace('href="/web/style.css"', 'href="shared/style.css"')
    .replace(
      '<main class="player">',
      `${read("chatter/connect.html").toString()}\n<main class="player" id="participant" hidden>`,
    )
    .replace("<h1>卓のチャット</h1>", "<h1>Chatter</h1>")
    .replace(
      "<summary>音声・再生設定（クリックで展開）</summary>",
      '<summary>音声・再生設定（クリックで展開）</summary><p id="connectionAddress" class="muted"></p>',
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
  files.set("panel.html", Buffer.from(html));
  return files;
}
