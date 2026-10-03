import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from './server.mjs';
import { wavDuration } from './synthesis.mjs';
const token = randomBytes(24).toString('hex');
const profiles = JSON.parse(readFileSync(new URL('./profiles.json', import.meta.url)));
const server = createBridge({ token, profiles, upstream: process.env.TTS_UPSTREAM ?? 'http://127.0.0.1:8088' });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/api/tts`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
try {
  const health = await fetch(`${base}/health`, { headers });
  console.log('Bridge health:', health.status, await health.json());
  const start = performance.now();
  const response = await fetch(`${base}/synthesize`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requestId: 'real-smoke',
      text: 'こんにちは。メリッサです。',
      profileId: 'melissa',
      styleId: 'default',
      settings: { seed: '1520596899881326291', steps: 10 },
    }),
    signal: AbortSignal.timeout(65000),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  const wav = Buffer.from(await response.arrayBuffer());
  const output = join(tmpdir(), 'axe-tts-bridge-smoke.wav');
  writeFileSync(output, wav);
  console.log(
    JSON.stringify({
      http: response.status,
      elapsedMs: Math.round(performance.now() - start),
      bytes: wav.length,
      durationMs: wavDuration(wav),
      revision: response.headers.get('X-TTS-Profile-Revision'),
      output,
    })
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
