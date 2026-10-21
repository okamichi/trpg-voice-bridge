import { crc32 } from "node:zlib";
import { chatterFiles } from "./files.mjs";
// STORE, fixed DOS date (1980-01-01), sorted UTF-8 names: reproducible across Node versions.
export function zipFiles(files) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, value] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const filename = Buffer.from(name),
      data = Buffer.from(value),
      crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function chatterDownload(read) {
  const files = chatterFiles(read);
  const { version } = JSON.parse(files.get("manifest.json"));
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version))
    throw new Error("Chatter version is invalid");
  return {
    content: zipFiles(files),
    filename: `trpg-voice-bridge-chatter-${version}.zip`,
  };
}
