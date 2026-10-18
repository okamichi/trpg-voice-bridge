import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isSea } from "node:sea";

// Keep the production dependency tree intact: prism-media resolves Opus at
// runtime and davey/opusscript load adjacent native/wasm files.
export const discordRequire = createRequire(
  isSea()
    ? join(dirname(process.execPath), "runtime/discord/package.json")
    : import.meta.url,
);

export function dependenciesInstalled() {
  try {
    for (const name of ["discord.js", "@discordjs/voice", "opusscript"])
      discordRequire.resolve(name);
    if (isSea()) {
      discordRequire("discord.js");
      discordRequire("@discordjs/voice");
      const Opus = discordRequire("opusscript");
      const encoder = new Opus(48000, 2, Opus.Application.AUDIO);
      try {
        encoder.encode(Buffer.alloc(960 * 4), 960);
      } finally {
        encoder.delete();
      }
    }
    return true;
  } catch {
    return false;
  }
}
