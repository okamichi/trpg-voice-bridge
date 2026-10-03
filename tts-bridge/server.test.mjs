import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createBridge } from './server.mjs';
const profiles = JSON.parse(readFileSync(new URL('./profiles.json', import.meta.url)));
function wav() {
  const b = Buffer.alloc(46);
  b.write('RIFF');
  b.writeUInt32LE(38, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt32LE(16000, 28);
  b.write('data', 36);
  b.writeUInt32LE(2, 40);
  return b;
}
test('認証・二重要求・シリアル生成・失敗後の続行', async () => {
  let calls = 0,
    active = 0,
    peak = 0;
  const server = createBridge({
    token: 'test-token-123456789',
    profiles,
    fetchImpl: async (_url, init) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active--;
      if (JSON.parse(init.body).input === '失敗') return new Response('error', { status: 503 });
      return new Response(wav(), { headers: { 'Content-Type': 'audio/wav' } });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/tts/synthesize`;
  const post = (id, text = 'こんにちは', auth = true) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: 'Bearer test-token-123456789' } : {}),
      },
      body: JSON.stringify({ requestId: id, text, profileId: 'melissa', styleId: 'default' }),
    });
  try {
    assert.equal((await post('private', 'こんにちは', false)).status, 401);
    assert.equal(calls, 0);
    const responses = await Promise.all([post('first'), post('first'), post('second')]);
    assert.ok(responses.every((r) => r.status === 200));
    assert.equal(calls, 2);
    assert.equal(peak, 1);
    assert.equal((await post('first', '変更')).status, 409);
    assert.equal((await post('failed', '失敗')).status, 502);
    assert.equal((await post('failed', '失敗')).status, 502);
    assert.equal(calls, 3);
    assert.equal((await post('next')).status, 200);
    assert.equal(calls, 4);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('参照音声登録は認証とWAV検証を行い、生成音声の内容から共通IDを作る', async () => {
  const uploaded = [];
  const server = createBridge({
    token: 'test-token-123456789',
    profiles,
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/v1/audio/voices'));
      assert.equal(init.method, 'POST');
      const form = init.body;
      uploaded.push(form.get('voice_id'));
      assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), wav());
      return new Response('{}', { status: uploaded.length === 1 ? 201 : 409 });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/tts/voices`;
  const post = (body, auth = true) =>
    fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'audio/wav', ...(auth ? { Authorization: 'Bearer test-token-123456789' } : {}) },
    });
  try {
    assert.equal((await post(wav(), false)).status, 401);
    assert.equal((await post(Buffer.from('not wav'))).status, 400);
    assert.equal(uploaded.length, 0);
    const first = await (await post(wav())).json();
    assert.match(first.id, /^axe-[a-f0-9]{64}$/);
    assert.deepEqual(await (await post(wav())).json(), first);
    assert.deepEqual(uploaded, [first.id, first.id]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
