import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  cpSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Some published packages omit their LICENSE. Pin supplements to the exact
// installed version and upstream source; never silently use a newer license.
export function supplementLicenses(modules, destination) {
  const sourceDir = fileURLToPath(new URL("./licenses/", import.meta.url));
  const supplements = JSON.parse(readFileSync(join(sourceDir, "sources.json")));
  const notices = [];
  function visit(dir, relative = "discord") {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name),
        prefix = `${relative}/${entry.name}`;
      if (entry.name.startsWith("@")) {
        visit(path, prefix);
        continue;
      }
      if (!existsSync(join(path, "package.json"))) continue;
      const info = JSON.parse(readFileSync(join(path, "package.json")));
      if (
        !readdirSync(path).some((name) =>
          /^(licen[sc]e|copying|notice)/i.test(name),
        )
      ) {
        const source = supplements.find(
          (s) => s.packages.includes(info.name) && s.version === info.version,
        );
        if (!source)
          throw Error(`Missing LICENSE: ${info.name}@${info.version}`);
        const text = readFileSync(join(sourceDir, source.file));
        if (createHash("sha256").update(text).digest("hex") !== source.sha256)
          throw Error(`License checksum mismatch: ${info.name}`);
        const target = join(destination, "dependencies", prefix, "LICENSE");
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(sourceDir, source.file), target);
        notices.push(`${prefix}/LICENSE`);
      }
      if (existsSync(join(path, "node_modules")))
        visit(join(path, "node_modules"), `${prefix}/node_modules`);
    }
  }
  visit(modules);
  cpSync(
    join(sourceDir, "sources.json"),
    join(destination, "supplemental-license-sources.json"),
  );
  return notices;
}
