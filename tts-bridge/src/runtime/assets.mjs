import { readFileSync } from "node:fs";
import { isSea, getAsset } from "node:sea";

// Asset names are selected by routes, never taken directly from request paths.
export function readAsset(name) {
  if (isSea()) return Buffer.from(getAsset(name));
  return readFileSync(new URL(`../../${name}`, import.meta.url));
}
