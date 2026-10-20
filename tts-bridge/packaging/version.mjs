import { readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));

export function projectVersion() {
  const { version } = readJson("package.json");
  if (
    typeof version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version.split(".").some((part) => Number(part) > 65535) ||
    version === "0.0.0"
  )
    throw Error(
      "Bridge・Collector・Chatterの共通バージョンはX.Y.Z（各0～65535、全て0は不可）で指定してください",
    );
  return version;
}

export function checkProjectVersion() {
  const version = projectVersion();
  const lock = readJson("package-lock.json");
  if (
    readJson("collector/manifest.json").version !== version ||
    readJson("chatter/manifest.json").version !== version ||
    lock.version !== version ||
    lock.packages[""].version !== version
  )
    throw Error(
      "バージョンが一致しません。npm run versionでCollector・Chatterとlockfileを同期してください",
    );
  if (
    process.env.GITHUB_REF_TYPE === "tag" &&
    process.env.GITHUB_REF_NAME !== `v${version}`
  )
    throw Error(`リリースタグはv${version}に合わせてください`);
  return version;
}

function synchronizeVersions() {
  const version = projectVersion();
  for (const name of [
    "collector/manifest.json",
    "chatter/manifest.json",
    "package-lock.json",
  ]) {
    const data = readJson(name);
    if (
      data.version === version &&
      (name !== "package-lock.json" || data.packages[""].version === version)
    )
      continue;
    data.version = version;
    if (name === "package-lock.json") data.packages[""].version = version;
    writeFileSync(join(root, name), JSON.stringify(data, null, 2) + "\n");
  }
  return version;
}

if (
  process.argv[1] &&
  existsSync(resolve(process.argv[1])) &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      process.argv.includes("--check")
        ? checkProjectVersion()
        : synchronizeVersions(),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
