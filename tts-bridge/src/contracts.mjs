import { createHash } from "node:crypto";
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function check(ok, message, status = 422) {
  if (!ok) throw new HttpError(status, message);
}
export const str = (x, max = 200) =>
  typeof x === "string" && x.length > 0 && x.length <= max;
export const id = (x) => str(x, 120) && /^[\w.-]+$/.test(x);
export const canonical = (x) => JSON.stringify(sort(x));
function sort(x) {
  return Array.isArray(x)
    ? x.map(sort)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, sort(x[k])]),
        )
      : x;
}
export const hash = (x) =>
  createHash("sha256")
    .update(typeof x === "string" ? x : canonical(x))
    .digest("hex");
export function eventSchema(e) {
  check(
    e?.schemaVersion === 1 && id(e.eventId) && id(e.roomId) && id(e.sessionId),
    "イベント識別子が不正です",
  );
  const s = e.source,
    p = e.speaker;
  check(
    ["fvtt", "udonarium", "ccfolia", "fixture"].includes(s?.adapter) &&
      id(s.instanceId) &&
      str(s.contextId) &&
      str(s.messageId) &&
      s.revision === 0,
    "入力元または発言IDが不正です",
  );
  check(
    p?.kind === "character" &&
      (p.id === null || str(p.id)) &&
      str(p.name) &&
      (!p.tokenId || str(p.tokenId)) &&
      (!p.sceneId || str(p.sceneId)),
    "発言者が不正です",
  );
  check(e.visibility === "public", "公開発言だけを受け付けます");
  check(
    ["dialogue", "narration"].includes(e.kind) && str(e.channel, 80),
    "発言種別が不正です",
  );
  check(
    str(e.text, 2000) &&
      e.text.trim() &&
      [...e.text].length <= 500 &&
      !/[<>\u0000]/.test(e.text),
    "本文は500文字以内のプレーンテキストが必要です",
  );
  check(
    str(e.occurredAt, 40) && Number.isFinite(Date.parse(e.occurredAt)),
    "発言日時が不正です",
  );
  return e;
}
export const sourceKey = (s) =>
  canonical([s.adapter, s.instanceId, s.contextId]);
export const eventKey = (e) =>
  canonical([
    e.roomId,
    e.source.adapter,
    e.source.instanceId,
    e.source.contextId,
    e.source.messageId,
    e.source.revision,
  ]);
export function voiceSchema(v) {
  check(v && typeof v === "object" && !Array.isArray(v), "声の設定が必要です");
  const supported = [
    "id",
    "name",
    "provider",
    "voiceId",
    "caption",
    "seed",
    "speed",
    "steps",
    "cfgScaleText",
    "cfgScaleCaption",
    "cfgScaleSpeaker",
  ];
  check(
    Object.keys(v).every((k) => supported.includes(k)),
    "未対応の音声パラメーターです",
  );
  check(id(v.id) && str(v.name), "声のID・名称が不正です");
  check(
    v.provider === "irodori-local" &&
      typeof v.voiceId === "string" &&
      /^[\w-]{1,100}$/.test(v.voiceId),
    "参照voiceが不正です",
  );
  check(
    typeof v.caption === "string" &&
      v.caption.length <= 1000 &&
      typeof v.seed === "string" &&
      /^\d{1,19}$/.test(v.seed) &&
      BigInt(v.seed) <= 9223372036854775807n,
    "captionまたはseedが不正です",
  );
  check(
    Number.isFinite(v.speed) &&
      v.speed >= 0.5 &&
      v.speed <= 2 &&
      Number.isInteger(v.steps) &&
      v.steps >= 1 &&
      v.steps <= 100,
    "速度・ステップ数が範囲外です",
  );
  for (const key of ["cfgScaleText", "cfgScaleCaption", "cfgScaleSpeaker"])
    if (v[key] !== undefined && v[key] !== null)
      check(
        Number.isFinite(v[key]) && v[key] >= 0 && v[key] <= 10,
        "CFG強度は0～10です",
      );
}
export function configSchema(c) {
  check(c?.configVersion === 1 && id(c.roomId), "設定形式が不正です");
  check(
    Array.isArray(c.allowedChannels) &&
      c.allowedChannels.length > 0 &&
      c.allowedChannels.every((x) => str(x, 80)),
    "公開チャネルが必要です",
  );
  check(
    Array.isArray(c.allowedKinds) &&
      c.allowedKinds.every((x) => ["dialogue", "narration"].includes(x)),
    "発言種別が不正です",
  );
  check(typeof c.publishTextToPlayers === "boolean", "字幕設定が不正です");
  check(
    c.sentencePauseMs === undefined ||
      (Number.isInteger(c.sentencePauseMs) &&
        c.sentencePauseMs >= 0 &&
        c.sentencePauseMs <= 3000),
    "文の間は0～3000ミリ秒です",
  );
  check(
    c.provider &&
      typeof c.provider.baseUrl === "string" &&
      URL.canParse(c.provider.baseUrl),
    "ProviderのURLが不正です",
  );
  const u = new URL(c.provider.baseUrl);
  check(
    ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/",
    "ProviderにはHTTP(S)のオリジンを指定します",
  );
  check(
    c.provider.model === "irodori-tts" &&
      ["irodori", "mock"].includes(c.provider.type),
    "Provider設定が不正です",
  );
  check(
    Array.isArray(c.characters) &&
      c.characters.length <= 500 &&
      Array.isArray(c.voiceProfiles) &&
      c.voiceProfiles.length <= 500,
    "登録上限は500件です",
  );
  const voices = new Set(),
    chars = new Set(),
    bindings = new Set();
  for (const v of c.voiceProfiles) {
    voiceSchema(v);
    check(!voices.has(v.id), "声のIDが重複しています", 409);
    voices.add(v.id);
  }
  for (const ch of c.characters) {
    check(
      ch &&
        id(ch.id) &&
        str(ch.displayName) &&
        typeof ch.enabled === "boolean" &&
        (ch.voiceProfileId === null || voices.has(ch.voiceProfileId)) &&
        Array.isArray(ch.bindings) &&
        ch.bindings.length <= 100,
      "キャラクター設定が不正です",
    );
    check(!chars.has(ch.id), "キャラIDが重複しています", 409);
    chars.add(ch.id);
    for (const b of ch.bindings) {
      check(
        b &&
          ["fvtt", "udonarium", "ccfolia", "fixture"].includes(b.adapter) &&
          id(b.instanceId) &&
          str(b.contextId),
        "bindingの入力元が不正です",
      );
      check(
        b.tokenId
          ? str(b.tokenId) && str(b.sceneId)
          : b.speakerId
            ? str(b.speakerId)
            : str(b.alias) && b.confirmUnique === true,
        "名前bindingは同名キャラがいないことの確認が必要です",
      );
      const k = bindingKey(b);
      check(!bindings.has(k), "同じ発言者は複数登録できません", 409);
      bindings.add(k);
    }
  }
  check(
    Array.isArray(c.sources) && c.sources.length <= 50,
    "入力元の上限は50件です",
  );
  const sources = new Set();
  for (const s of c.sources) {
    check(
      s &&
        ["fvtt", "udonarium", "ccfolia", "fixture"].includes(s.adapter) &&
        id(s.instanceId) &&
        str(s.contextId),
      "入力元が不正です",
    );
    check(!sources.has(sourceKey(s)), "入力元が重複しています", 409);
    sources.add(sourceKey(s));
  }
  return c;
}
export const bindingKey = (b) =>
  canonical([
    b.adapter,
    b.instanceId,
    b.contextId,
    b.tokenId
      ? ["token", b.sceneId, b.tokenId]
      : b.speakerId
        ? ["id", b.speakerId]
        : ["alias", b.alias],
  ]);
export function resolveCharacter(c, e) {
  for (const kind of ["token", "id", "alias"]) {
    const found = c.characters.filter((ch) =>
      ch.bindings.some(
        (b) =>
          sourceKey(b) === sourceKey(e.source) &&
          (kind === "token"
            ? b.tokenId &&
              b.tokenId === e.speaker.tokenId &&
              b.sceneId === e.speaker.sceneId
            : kind === "id"
              ? !b.tokenId && b.speakerId && b.speakerId === e.speaker.id
              : !b.tokenId &&
                !b.speakerId &&
                b.confirmUnique &&
                b.alias === e.speaker.name),
      ),
    );
    if (found.length) return found.length === 1 ? found[0] : null;
  }
  return e.kind === "narration"
    ? c.characters.find((x) => x.id === c.narratorId)
    : null;
}
