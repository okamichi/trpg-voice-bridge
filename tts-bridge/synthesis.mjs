import { createHash } from 'node:crypto';
import { parseDelivery } from './delivery.mjs';
export const MAX_BYTES = 10 * 1024 * 1024;
export function resolveRequest(body, profiles) {
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.requestId !== 'string' ||
    !/^[\w-]{1,100}$/.test(body.requestId) ||
    typeof body.text !== 'string' ||
    !body.text.trim() ||
    [...body.text].length > 300
  )
    throw new Error('不正な発声要求');
  const profile = Object.hasOwn(profiles, body.profileId ?? '') ? profiles[body.profileId] : null;
  const style =
    profile?.styles && Object.hasOwn(profile.styles, body.styleId ?? 'default')
      ? profile.styles[body.styleId ?? 'default']
      : null;
  if (!profile || !style) throw new Error('未登録のプロファイル／スタイル');
  const p = { ...profile, ...style };
  const override = body.settings;
  if (override && !p.allowCharacterOverrides) throw new Error('このプロファイルの声設定はサーバー側で固定されています');
  if (override) {
    for (const key of ['caption', 'seed', 'steps', 'speed', 'cfgScaleText', 'cfgScaleCaption', 'cfgScaleSpeaker'])
      if (override[key] !== undefined) p[key] = override[key];
    if (override.voiceId !== undefined) {
      if (typeof override.voiceId !== 'string' || !/^(?:[\w-]{1,100})?$/.test(override.voiceId))
        throw new Error('参照音声IDが不正です');
      if (override.voiceId) p.voice = override.voiceId;
    }
  }
  if (
    typeof p.caption !== 'string' ||
    p.caption.length > 1000 ||
    typeof p.seed !== 'string' ||
    !/^\d{1,19}$/.test(p.seed) ||
    BigInt(p.seed) > 9223372036854775807n ||
    !Number.isInteger(p.steps) ||
    p.steps < 1 ||
    p.steps > 100 ||
    !Number.isFinite(p.speed) ||
    p.speed < 0.5 ||
    p.speed > 2 ||
    typeof p.voice !== 'string' ||
    !/^[\w-]{1,100}$/.test(p.voice)
  )
    throw new Error('声設定の範囲が不正です');
  const guidance = {};
  for (const [key, apiKey] of [
    ['cfgScaleText', 'cfg_scale_text'],
    ['cfgScaleCaption', 'cfg_scale_caption'],
    ['cfgScaleSpeaker', 'cfg_scale_speaker'],
  ]) {
    if (p[key] === undefined) continue;
    if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] > 10) throw new Error('CFG強度は0～10で指定してください');
    guidance[apiKey] = p[key];
  }
  const delivery = parseDelivery(body.text);
  const caption = delivery.caption
    ? [p.caption, `この発言の演技指示: ${delivery.caption}。`].filter(Boolean).join('。')
    : p.caption;
  if (caption.length > 1000) throw new Error('声色と演技指示の合計は1000文字以下にしてください');
  const payload = {
    model: 'irodori-tts',
    voice: p.voice,
    input: delivery.input,
    response_format: 'wav',
    speed: p.speed,
    // Preserve inline acting cues across the whole utterance, including with a reference voice.
    irodori: {
      caption,
      seed: '__EXACT_SEED__',
      num_steps: p.steps,
      max_seconds: 60,
      chunking_enabled: false,
      ...guidance,
    },
  };
  // Decimal digits are validated above. Do not pass a 64-bit seed through a JS number.
  const json = JSON.stringify(payload).replace('"seed":"__EXACT_SEED__"', `"seed":${BigInt(p.seed).toString()}`);
  const settingsHash = createHash('sha256')
    .update(
      JSON.stringify({
        voice: p.voice,
        caption,
        seed: p.seed,
        steps: p.steps,
        speed: p.speed,
        model: payload.model,
        guidance,
      })
    )
    .digest('hex')
    .slice(0, 16);
  return { json, revision: `${String(p.revision ?? '1')}.${settingsHash}` };
}
export function wavDuration(buffer) {
  if (
    buffer.length < 44 ||
    buffer.length > MAX_BYTES ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE' ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  )
    throw new Error('不正なWAV');
  let rate = 0,
    dataBytes = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    if (offset + 8 + size > buffer.length) throw new Error('WAVが破損しています');
    const tag = buffer.toString('ascii', offset, offset + 4);
    if (tag === 'fmt ') {
      if (size < 16 || ![1, 3, 65534].includes(buffer.readUInt16LE(offset + 8))) throw new Error('非対応のWAV');
      rate = buffer.readUInt32LE(offset + 16);
    }
    if (tag === 'data') dataBytes += size;
    offset += 8 + size + (size % 2);
  }
  const duration = (dataBytes / rate) * 1000;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60000) throw new Error('音声は60秒以下にしてください');
  return duration;
}
export async function readLimited(response, limit = MAX_BYTES) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) throw new Error('応答が大きすぎます');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('応答が大きすぎます');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel();
    throw error;
  }
}
