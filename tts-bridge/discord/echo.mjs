// A member listening on speakers can send the bot's own reading back through
// their microphone. Such an utterance is told apart by what it says: most of
// it is in a text the bot was reading at the time.
const hiragana = (text) =>
  text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
export const normalize = (text) =>
  hiragana(text.normalize("NFKC")).replace(/[\s\p{P}\p{S}]/gu, "");
const pairs = (text) =>
  Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2));

// The share of `heard`'s character pairs that are in `spoken`, 0 to 1.
export function overlap(heard, spoken) {
  const h = normalize(heard),
    s = normalize(spoken);
  if (!h) return 0;
  if (h.length < 2) return s.includes(h) ? 1 : 0;
  const pool = new Set(pairs(s));
  const grams = pairs(h);
  return grams.filter((g) => pool.has(g)).length / grams.length;
}

// `threshold` 0 turns the guard off. `tailMs` covers the delay of the reading
// coming back after the bot stops.
export class EchoGuard {
  constructor({
    threshold = 0.5,
    tailMs = 2000,
    keepMs = 60000,
    now = () => Date.now(),
  } = {}) {
    Object.assign(this, { threshold, tailMs, keepMs, now });
    this.readings = [];
  }
  // Call as the bot starts to play `text`; call end() when it stops.
  playing(text) {
    const reading = { text, start: this.now(), end: Infinity };
    this.prune();
    this.readings.push(reading);
    return {
      end: () => {
        reading.end = this.now();
      },
    };
  }
  prune() {
    const cutoff = this.now() - this.keepMs;
    this.readings = this.readings.filter((r) => r.end > cutoff);
  }
  // Keep references to active readings: their end time is filled in later.
  snapshot(from, to) {
    this.prune();
    return this.readings.filter(
      (r) => r.start <= +to && +from <= r.end + this.tailMs,
    );
  }
  // Whether `text`, heard from `from` to `to`, is the bot's own reading.
  echoes(text, from, to, readings = this.snapshot(from, to)) {
    if (!this.threshold) return false;
    return readings.some(
      (r) =>
        r.start <= +to &&
        +from <= r.end + this.tailMs &&
        overlap(text, r.text) >= this.threshold,
    );
  }
}
