import { chatterAssets } from "../chatter/files.mjs";
import { build } from "esbuild";
import { inject } from "postject";
import {
  cpSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { initialConfig } from "../src/store.mjs";
import { assertPackagePrivacy, snapshotUpstreamBinaries } from "./privacy.mjs";
import { supplementLicenses } from "./licenses.mjs";
import { checkProjectVersion } from "./version.mjs";
import { buildChatter } from "../chatter/build.mjs";
import { speechBuildMatches, speechTarget } from "../src/runtime/speech.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const required = readFileSync(
  new URL("./node-version", import.meta.url),
  "utf8",
).trim();
if (process.versions.node !== required)
  throw Error(`Build with Node.js ${required}, got ${process.version}`);
const target = speechTarget();
if (!target)
  throw Error(
    "Supported targets: darwin-arm64 / win32-x64 (native builds only)",
  );
const version = checkProjectVersion();
const scratch = join(root, ".packaging");
mkdirSync(scratch, { recursive: true });
const work = mkdtempSync(join(scratch, "build-"));
const destination = join(root, "dist", target);
const stage = join(work, "TRPG-Voice-Bridge");
mkdirSync(stage);
const runtime = join(stage, "runtime/discord");
mkdirSync(runtime, { recursive: true });
for (const name of ["package.json", "package-lock.json"])
  cpSync(join(root, "discord", name), join(runtime, name));
// npm is a build-time dependency only. Its CLI is invoked by the pinned Node.
const npmCli =
  process.env.npm_execpath ??
  join(
    dirname(process.execPath),
    process.platform === "win32"
      ? "node_modules/npm/bin/npm-cli.js"
      : "../lib/node_modules/npm/bin/npm-cli.js",
  );
execFileSync(
  process.execPath,
  [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd: runtime, stdio: "inherit" },
);
const upstreamBinaries = snapshotUpstreamBinaries(
  join(runtime, "node_modules"),
  relative(stage, join(runtime, "node_modules")),
);

const speechDir = join(root, ".packaging/speech-runtime");
const speechInfo = JSON.parse(readFileSync(join(speechDir, "build.json")));
const speechPins = JSON.parse(
  readFileSync(join(root, "packaging/speech-lock.json")),
);
if (!speechBuildMatches(speechInfo, speechPins, target))
  throw Error("Run package:speech for this target and pinned source first");
cpSync(speechDir, join(stage, "runtime/speech"), { recursive: true });
const bundle = join(work, "bridge.cjs");
await build({
  entryPoints: [join(root, "packaging/entry.mjs")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  // import.meta is only used on the development path or to construct the
  // filesystem require anchor. SEA resources are accessed through node:sea.
  define: { "import.meta.url": "__bridgeModuleUrl" },
  banner: {
    js: 'const __bridgeModuleUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  external: ["bufferutil", "utf-8-validate"],
});
const assets = {
  "credits/TRPG-Voice-Bridge-LICENSE": join(root, "../LICENSE"),
  "credits/speech.cpp-LICENSE": join(
    root,
    ".packaging/speech-runtime/speech.cpp-LICENSE",
  ),
};
for (const file of readdirSync(join(root, "web"))) {
  if (/\.(html|js|css)$/.test(file))
    assets[`web/${file}`] = join(root, "web", file);
}
for (const file of chatterAssets)
  assets[`chatter/${file}`] = join(root, "chatter", file);
assets["discord/admin.js"] = join(root, "discord/admin.js");
const defaults = join(work, "config.json");
writeFileSync(defaults, JSON.stringify(initialConfig({}), null, 2));
assets["config.json"] = defaults;
const info = {
  version,
  speech: speechInfo,
  node: process.version,
  target,
  ws: JSON.parse(readFileSync(join(root, "node_modules/ws/package.json")))
    .version,
  discord: JSON.parse(readFileSync(join(runtime, "package.json"))).dependencies,
};
writeFileSync(join(work, "build-info.json"), JSON.stringify(info, null, 2));
assets["build-info.json"] = join(work, "build-info.json");
const blob = join(work, "sea.blob");
const config = join(work, "sea.json");
writeFileSync(
  config,
  JSON.stringify({
    // SEA preserves this filename in the executable. Never embed the builder's
    // absolute workspace path (which includes their local account name).
    main: "bridge.cjs",
    output: blob,
    assets,
    useCodeCache: false,
    useSnapshot: false,
    execArgvExtension: "none",
    disableExperimentalSEAWarning: true,
  }),
);
execFileSync(process.execPath, ["--experimental-sea-config", config], {
  cwd: work,
  stdio: "inherit",
});
const exe = join(
  stage,
  `trpg-voice-bridge${process.platform === "win32" ? ".exe" : ""}`,
);
cpSync(process.execPath, exe);
chmodSync(exe, 0o755);
if (process.platform === "darwin")
  execFileSync("codesign", ["--remove-signature", exe]);
await inject(exe, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", exe]);
  execFileSync("codesign", ["--verify", "--strict", exe]);
}
cpSync(join(root, "collector"), join(stage, "collector"), { recursive: true });
await buildChatter(join(stage, "chatter"));
cpSync(join(root, "../LICENSE"), join(stage, "LICENSE"));
cpSync(join(root, "packaging/README.txt"), join(stage, "README.txt"));
cpSync(join(work, "build-info.json"), join(stage, "build-info.json"));
const licenses = join(stage, "licenses");
mkdirSync(licenses);
const nodeLicense = [
  join(dirname(process.execPath), "../LICENSE"),
  join(dirname(process.execPath), "LICENSE"),
].find(existsSync);
if (!nodeLicense)
  throw Error(
    "Official Node.js LICENSE must be present beside the build runtime",
  );
cpSync(nodeLicense, join(licenses, "Node.js-LICENSE"));
const notices = [];
function collectLicenses(dir, prefix) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) collectLicenses(path, relative);
    else if (/^(licen[sc]e|copying|notice)/i.test(entry.name)) {
      const dest = join(licenses, "dependencies", relative);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(path, dest);
      notices.push(relative);
    }
  }
}
collectLicenses(join(runtime, "node_modules"), "discord");
collectLicenses(join(root, "node_modules/ws"), "ws");
notices.push(...supplementLicenses(join(runtime, "node_modules"), licenses));
writeFileSync(
  join(licenses, "THIRD-PARTY-NOTICES"),
  `Node.js: Node.js-LICENSE\nBundled ws and external Discord production dependencies:\n${notices.sort().join("\n")}\nSupplement sources: supplemental-license-sources.json\nspeech.cpp and ggml: ../runtime/speech/speech.cpp-LICENSE, ../runtime/speech/ggml-LICENSE\nspeech.cpp vendor notices: ../runtime/speech/licenses/\nVersions and integrity: runtime/discord/package-lock.json and build-info.json\n`,
);
execFileSync(exe, ["--self-test"], { cwd: work, stdio: "inherit" });
assertPackagePrivacy(stage, root, upstreamBinaries);
// Only replace this script's generated target directory after a successful build.
mkdirSync(dirname(destination), { recursive: true });
rmSync(destination, { recursive: true, force: true });
cpSync(stage, destination, { recursive: true });
const checksum = createHash("sha256").update(readFileSync(exe)).digest("hex");
writeFileSync(
  join(destination, "SHA256SUMS"),
  `${checksum}  ${process.platform === "win32" ? "trpg-voice-bridge.exe" : "trpg-voice-bridge"}\n`,
);
console.log(`Package: ${destination}`);
const archive = join(
  root,
  "dist",
  `trpg-voice-bridge-${version}-${target}.zip`,
);
if (process.platform === "darwin") {
  // -X omits Unix owner IDs and extended metadata. Create a fresh archive so
  // files from an earlier build can never survive an incremental ZIP update.
  const freshArchive = join(work, "package.zip");
  execFileSync(
    "/usr/bin/zip",
    ["-X", "-q", "-r", freshArchive, "TRPG-Voice-Bridge"],
    { cwd: work },
  );
  cpSync(freshArchive, archive);
} else {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Compress-Archive -LiteralPath $env:BRIDGE_PACKAGE_SOURCE -DestinationPath $env:BRIDGE_PACKAGE_ZIP -Force",
    ],
    {
      env: {
        ...process.env,
        BRIDGE_PACKAGE_SOURCE: stage,
        BRIDGE_PACKAGE_ZIP: archive,
      },
    },
  );
}
writeFileSync(
  `${archive}.sha256`,
  `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${archive.split(/[\\/]/).at(-1)}\n`,
);
console.log(`Archive: ${archive}`);
