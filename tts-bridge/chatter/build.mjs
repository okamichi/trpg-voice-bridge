import { chatterFiles } from "./files.mjs";
import { readAsset } from "../src/runtime/assets.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProjectVersion } from "../packaging/version.mjs";
const source = fileURLToPath(new URL("./", import.meta.url));
// Build into a fresh package directory from an explicit asset list, never by
// copying the developer's generated folder (which may be stale or contain data).
export async function buildChatter(destination = source) {
  checkProjectVersion();
  destination = resolve(destination);
  for (const [name, content] of chatterFiles(readAsset)) {
    const path = join(destination, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
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
