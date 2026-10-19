import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { assertPackagePrivacy, snapshotUpstreamBinaries } from "./privacy.mjs";

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

test("upstream home-path collisions require an unchanged native dependency", () => {
  const directory = mkdtempSync(join(tmpdir(), "package-provenance-"));
  try {
    const prefix = join("runtime", "discord", "node_modules");
    const dependencies = join(directory, prefix);
    mkdirSync(dependencies, { recursive: true });
    const native = join(dependencies, "upstream.node");
    const contents = `${homedir()}/public-upstream-build/source.rs`;
    writeFileSync(native, contents);
    const baseline = snapshotUpstreamBinaries(dependencies, prefix);
    assert.doesNotThrow(() =>
      assertPackagePrivacy(directory, directory, baseline),
    );
    // Our own binaries and any changed upstream binary still fail the gate.
    writeFileSync(join(directory, "bridge.node"), contents);
    assert.throws(
      () => assertPackagePrivacy(directory, directory, baseline),
      /builder home path/,
    );
    rmSync(join(directory, "bridge.node"));
    writeFileSync(native, contents + " modified");
    assert.throws(
      () => assertPackagePrivacy(directory, directory, baseline),
      /builder home path/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("upstream provenance never exempts the current workspace path", () => {
  const directory = mkdtempSync(join(tmpdir(), "package-workspace-"));
  try {
    const native = join(directory, "upstream.node");
    writeFileSync(native, `${directory}/private/source.rs`);
    const baseline = snapshotUpstreamBinaries(directory, "");
    assert.throws(
      () => assertPackagePrivacy(directory, directory, baseline),
      /builder workspace path/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
