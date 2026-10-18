import { readdirSync, readFileSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { homedir, hostname } from "node:os";

// Check the staged product, including native binaries, before it is published.
// Report only the category and relative filename, never the matched value.
export function assertPackagePrivacy(directory, workspace) {
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
          if (contents.includes(Buffer.from(value, encoding)))
            throw Error(`Package privacy check: ${category} in ${name}`);
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
