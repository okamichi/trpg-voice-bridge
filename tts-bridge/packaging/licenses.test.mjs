import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { supplementLicenses } from "./licenses.mjs";

for (const [name, version, succeeds] of [
  ["@snazzah/davey", "0.1.12", true],
  ["@snazzah/davey", "99.0.0", false],
  ["unreviewed-package", "1.0.0", false],
]) {
  test(`license supplement checks exact package/version: ${name}@${version}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "license-test-"));
    try {
      const modules = join(dir, "modules"),
        output = join(dir, "licenses");
      mkdirSync(join(modules, name), { recursive: true });
      mkdirSync(output);
      writeFileSync(
        join(modules, name, "package.json"),
        JSON.stringify({ name, version }),
      );
      if (succeeds) {
        const files = supplementLicenses(modules, output);
        assert.equal(files.length, 1);
        assert.match(
          readFileSync(join(output, "dependencies", files[0]), "utf8"),
          /Copyright.*Snazzah/,
        );
      } else
        assert.throws(
          () => supplementLicenses(modules, output),
          /Missing LICENSE/,
        );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
