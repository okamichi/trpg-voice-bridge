import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { assertPackagePrivacy } from "./privacy.mjs";

for (const encoding of ["utf8", "utf16le"]) {
  test(`privacy gate rejects local paths inside binaries (${encoding}) without printing them`, () => {
    const directory = mkdtempSync(join(tmpdir(), "package-privacy-"));
    try {
      writeFileSync(
        join(directory, "app.node"),
        Buffer.from(`${homedir()}/private-build/source.cjs`, encoding),
      );
      assert.throws(
        () => assertPackagePrivacy(directory, directory),
        (error) => {
          assert.match(error.message, /builder home path/);
          assert.ok(!error.message.includes(homedir()));
          return true;
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
test("privacy gate rejects user DB artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "package-privacy-"));
  try {
    writeFileSync(join(directory, "bridge.sqlite"), "fixture");
    assert.throws(
      () => assertPackagePrivacy(directory, directory),
      /Private artifact/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
