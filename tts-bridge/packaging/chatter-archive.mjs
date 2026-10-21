import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
// Inspect our STORE archives independently of the writer; reject corrupt entries.
export function readChatterArchive(zip) {
  const files = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0);
    const size = zip.readUInt32LE(offset + 18);
    const length = zip.readUInt16LE(offset + 26);
    const extra = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + length).toString();
    assert.ok(!name.startsWith("/") && !name.split("/").includes(".."));
    const start = offset + 30 + length + extra;
    const content = zip.subarray(start, start + size);
    assert.equal(crc32(content), zip.readUInt32LE(offset + 14));
    assert.ok(!files.has(name));
    files.set(name, content);
    offset = start + size;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt32LE(end + 16), offset);
  assert.equal(zip.readUInt16LE(end + 10), files.size);
  return files;
}
