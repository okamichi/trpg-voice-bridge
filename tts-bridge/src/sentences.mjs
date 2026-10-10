import { DELIVERY_EMOJI, parseDelivery } from "../delivery.mjs";

export const MAX_PARTS = 10;
const END = new Set(["。", "！", "？", "!", "?", "\n"]);
// Closing marks and repeated ends stay with the sentence they close.
const TRAILING = new Set([
  ...END,
  "」",
  "』",
  "）",
  ")",
  "】",
  "…",
  "‥",
  "〜",
  "ー",
  " ",
  "　",
  "\t",
  "\r",
]);
const FREE_CUE =
  /\[(感情|演技)[:：]([^\[\]\r\n]*)\]|（\s*(感情|演技)[:：]([^（）\r\n]*)）/g;

function speakable(text) {
  try {
    return /[\p{L}\p{N}]/u.test(parseDelivery(text).input);
  } catch {
    return false;
  }
}

/**
 * Splits one chat message into sentences that can be synthesized and played one
 * after another. Free-form acting cues apply to the whole message, so they are
 * carried into every part; word and emoji cues stay where they were written.
 * Returns [{ text, display }], where `text` is what goes to the TTS and
 * `display` is the sentence as it was written.
 */
export function splitUtterance(source, maxParts = MAX_PARTS) {
  const sentences = [];
  let current = "",
    depth = 0;
  const chars = [...source];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    current += c;
    if (c === "（" || c === "[") depth++;
    else if ((c === "）" || c === "]") && depth > 0) depth--;
    if (depth === 0 && END.has(c)) {
      while (i + 1 < chars.length && TRAILING.has(chars[i + 1]))
        current += chars[++i];
      sentences.push(current);
      current = "";
    }
  }
  if (current) sentences.push(current);

  const free = [];
  for (const m of source.matchAll(FREE_CUE)) {
    const value = (m[2] ?? m[4]).trim();
    if (!Object.hasOwn(DELIVERY_EMOJI, value)) free.push(m[0]);
  }
  const strip = (s) =>
    s.replace(FREE_CUE, (tag, k1, v1, k2, v2) =>
      Object.hasOwn(DELIVERY_EMOJI, (v1 ?? v2).trim()) ? tag : "",
    );

  // A part with nothing to speak (only a cue, an emoji or punctuation) joins the next one.
  const parts = [];
  let carry = "";
  for (const s of sentences) {
    const display = carry + s;
    if (!speakable(strip(display))) {
      carry = display;
      continue;
    }
    parts.push(display);
    carry = "";
  }
  if (carry) {
    if (parts.length) parts[parts.length - 1] += carry;
    else parts.push(carry);
  }
  while (parts.length > maxParts) {
    const last = parts.pop();
    parts[parts.length - 1] += last;
  }

  if (parts.length <= 1) return [{ text: source, display: source.trim() }];
  return parts.map((p) => ({
    text: free.join("") + strip(p).trim(),
    display: p.trim(),
  }));
}
