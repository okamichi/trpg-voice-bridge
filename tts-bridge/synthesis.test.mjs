import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveRequest, wavDuration } from './synthesis.mjs';
const profiles = JSON.parse(readFileSync(new URL('./profiles.json', import.meta.url)));
const request = { requestId: 'req-1', text: 'こんにちは', profileId: 'melissa', styleId: 'default' };
export function fixtureWav() {
  const b = Buffer.alloc(44 + 16000);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(16000, 40);
  return b;
}
test('19桁のシードを丸めず num_steps に渡す', () => {
  const { json } = resolveRequest(request, profiles);
  assert.match(json, /"seed":1520596899881326291/);
  assert.match(json, /"num_steps":10/);
  assert.doesNotMatch(json, /"steps":/);
});
test('PCの声色・シード・速度を適用し、パスやモデルの上書きを無視', () => {
  const { json } = resolveRequest(
    {
      ...request,
      settings: {
        caption: '落ち着いた男性',
        seed: '123',
        speed: 1.2,
        steps: 20,
        ref_wav: '/etc/passwd',
        model: 'evil',
      },
    },
    profiles
  );
  assert.match(json, /"seed":123/);
  assert.match(json, /落ち着いた男性/);
  assert.doesNotMatch(json, /passwd|evil/);
});
test('キャラごとの登録済み参照音声IDを使い、パスを拒否する', () => {
  const before = structuredClone(profiles);
  const anchored = resolveRequest({ ...request, settings: { voiceId: 'axe-voice-a' } }, profiles);
  assert.equal(JSON.parse(anchored.json).voice, 'axe-voice-a');
  assert.notEqual(anchored.revision, resolveRequest(request, profiles).revision);
  assert.equal(JSON.parse(resolveRequest({ ...request, settings: { voiceId: '' } }, profiles).json).voice, 'none');
  assert.deepEqual(profiles, before);
  for (const voiceId of ['/etc/passwd', '../voice', 'https://example.com/voice.wav', 123, null])
    assert.throws(() => resolveRequest({ ...request, settings: { voiceId } }, profiles));
  const locked = structuredClone(profiles);
  locked.melissa.allowCharacterOverrides = false;
  assert.throws(() => resolveRequest({ ...request, settings: { voiceId: 'axe-voice-a' } }, locked));
});
test('不正なシード、上限超過、未登録プロファイルを拒否', () => {
  for (const settings of [
    { seed: 1520596899881326291 },
    { seed: '1e10' },
    { seed: '9223372036854775808' },
    { steps: 101 },
    { speed: 10 },
  ]) {
    assert.throws(() => resolveRequest({ ...request, settings }, profiles));
  }
  assert.throws(() => resolveRequest({ ...request, text: 'あ'.repeat(301) }, profiles));
  assert.throws(() => resolveRequest({ ...request, profileId: '__proto__' }, profiles));
});
test('v4-Largeの絵文字と日本語タグで途中の演技を制御し、PCの声とシードを維持', () => {
  const { json } = resolveRequest({ ...request, text: '[感情:怒り]やめて！[演技:囁き]聞いて。😭' }, profiles);
  const payload = JSON.parse(json);
  assert.equal(payload.input, '😠やめて！👂聞いて。😭');
  assert.equal(payload.irodori.caption, profiles.melissa.caption);
  assert.equal(payload.voice, 'none');
  assert.equal(payload.irodori.chunking_enabled, false);
  assert.match(json, /"seed":1520596899881326291/);
});
test('参照音声があっても句点で分割せず、途中の演技指示を一緒に生成する', () => {
  const payload = JSON.parse(
    resolveRequest(
      {
        ...request,
        text: '[感情:怒り]やめてください。これ以上は許しません。[演技:囁き]誰かが来ました。',
        settings: { voiceId: 'axe-reference' },
      },
      profiles
    ).json
  );
  assert.equal(payload.voice, 'axe-reference');
  assert.equal(payload.input, '😠やめてください。これ以上は許しません。👂誰かが来ました。');
  assert.equal(payload.irodori.chunking_enabled, false);
});
test('自由な演技指示だけcaptionに追加し、普通のカッコ・未知のタグは本文に残す', () => {
  const original = structuredClone(profiles);
  const { json } = resolveRequest(
    { ...request, text: '[演技:ためらいながら]（本当に？）[注釈:例]こんにちは。' },
    profiles
  );
  const payload = JSON.parse(json);
  assert.equal(payload.input, '（本当に？）[注釈:例]こんにちは。');
  assert.ok(payload.irodori.caption.startsWith(profiles.melissa.caption));
  assert.match(payload.irodori.caption, /ためらいながら/);
  assert.deepEqual(profiles, original);
  assert.notEqual(
    resolveRequest(request, profiles).revision,
    resolveRequest({ ...request, text: '[演技:ためらいながら]こんにちは' }, profiles).revision
  );
});
test('丸カッコの定型タグと自由な演技指示を変換し、普通のカッコは残す', () => {
  const payload = JSON.parse(
    resolveRequest(
      {
        ...request,
        text: '（怒り）もう！怒ってるんだから！（演技：強い怒りをこめて）（本当に？）（囁き）聞いて。[感情:喜び]ありがとう。',
      },
      profiles
    ).json
  );
  assert.equal(payload.input, '😠もう！怒ってるんだから！（本当に？）👂聞いて。😆ありがとう。');
  assert.match(payload.irodori.caption, /演技: 強い怒りをこめて/);
  assert.equal(
    JSON.parse(resolveRequest({ ...request, text: '（感情:悲しみ）さようなら。' }, profiles).json).input,
    '😭さようなら。'
  );
});
test('不完全な演技記法・本文なし・指示超過を生成前に拒否', () => {
  for (const text of ['[感情:怒り', '[演技:]本文', '[感情:通常]', `[演技:${'あ'.repeat(101)}]本文`])
    assert.throws(() => resolveRequest({ ...request, text }, profiles));
  for (const text of ['（演技：怒り', '（演技：）本文', '（通常）', `（演技：${'あ'.repeat(101)}）本文`])
    assert.throws(() => resolveRequest({ ...request, text }, profiles));
});
test('3系統のCFGを公式API名で送り、未指定はサーバ既定値、範囲外は拒否', () => {
  const base = JSON.parse(resolveRequest(request, profiles).json);
  assert.equal(base.irodori.cfg_scale_caption, undefined);
  const settings = { cfgScaleText: 3, cfgScaleCaption: 4, cfgScaleSpeaker: 5 };
  const { json, revision } = resolveRequest({ ...request, settings }, profiles);
  const options = JSON.parse(json).irodori;
  assert.equal(options.cfg_scale_text, 3);
  assert.equal(options.cfg_scale_caption, 4);
  assert.equal(options.cfg_scale_speaker, 5);
  assert.notEqual(revision, resolveRequest(request, profiles).revision);
  assert.equal(
    JSON.parse(resolveRequest({ ...request, settings: { cfgScaleCaption: 0 } }, profiles).json).irodori
      .cfg_scale_caption,
    0
  );
  for (const value of [-1, 11, '3', null, Infinity])
    assert.throws(() => resolveRequest({ ...request, settings: { cfgScaleCaption: value } }, profiles));
});
test('WAV長さを検証し、破損を拒否', () => {
  assert.equal(wavDuration(fixtureWav()), 1000);
  assert.throws(() => wavDuration(Buffer.from('no audio')));
  const b = fixtureWav();
  b.writeUInt32LE(99999999, 40);
  assert.throws(() => wavDuration(b));
});
