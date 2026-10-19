import { readdirSync, readFileSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";

const digest = (contents) =>
  createHash("sha256").update(contents).digest("hex");

// Call only immediately after npm ci --ignore-scripts in a fresh staging tree.
// The lockfile-verified upstream binaries can contain their public CI paths.
export function snapshotUpstreamBinaries(directory, prefix) {
  const files = new Map();
  function visit(dir, relativeDir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name),
        name = join(relativeDir, entry.name);
      if (entry.isDirectory()) visit(file, name);
      else if (entry.isFile() && entry.name.endsWith(".node"))
        files.set(name, digest(readFileSync(file)));
    }
  }
  visit(directory, prefix);
  return files;
}

// Check the staged product, including native binaries, before it is published.
// Report only the category and relative filename, never the matched value.
export function assertPackagePrivacy(
  directory,
  workspace,
  upstreamBinaries = new Map(),
) {
  const markers = [
    ["builder home path", homedir()],
    ["builder workspace path", workspace],
    ["builder hostname", hostname()],
  ]
    .filter(([, value]) => value && value.length > 3)
    .flatMap(([category, value]) =>
      [
        ...new Set([
          value,
          value.replaceAll("\\", "/"),
          value.replaceAll("/", "\\"),
        ]),
      ].map((v) => [category, v]),
    );
  let files = 0;
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      const name = relative(directory, file);
      if (
        ["data", ".git", ".DS_Store", "__MACOSX"].includes(entry.name) ||
        /^\.env(?:\.|$)/.test(entry.name) ||
        /\.(?:sqlite(?:-wal|-shm)?|log|pem|key|p12)$/i.test(entry.name)
      ) {
        throw Error(`Private artifact in package: ${name}`);
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      const contents = readFileSync(file);
      for (const [category, value] of markers) {
        for (const encoding of ["utf8", "utf16le"]) {
          if (contents.includes(Buffer.from(value, encoding))) {
            // A generic runner home may match the upstream compiler's home.
            // Only an unchanged upstream .node file may retain that value;
            // our workspace/hostname checks and all other files still apply.
            if (
              category === "builder home path" &&
              name.endsWith(".node") &&
              upstreamBinaries.get(name) === digest(contents)
            )
              continue;
            throw Error(`Package privacy check: ${category} in ${name}`);
          }
        }
      }
      if (
        basename(file) === "discord.json" ||
        basename(file) === "bridge.sqlite"
      )
        throw Error(`User settings in package: ${name}`);
      files++;
    }
  }
  visit(directory);
  console.log(`Package privacy check: ${files} files checked`);
}
