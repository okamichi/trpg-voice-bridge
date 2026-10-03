import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MAX_BYTES, readLimited, resolveRequest, wavDuration } from './synthesis.mjs';

export function createBridge({
  token,
  profiles,
  upstream = 'http://127.0.0.1:8088',
  fetchImpl = fetch,
  timeoutMs = 60000,
}) {
  if (!token || token.length < 16) throw new Error('TTS_BRIDGE_TOKEN は16文字以上必要です');
  const jobs = new Map();
  let pending = 0;
  let tail = Promise.resolve();
  const authorized = (req) => {
    const received = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    return received.length === expected.length && timingSafeEqual(received, expected);
  };
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // No permissive CORS: serve this API behind Axe's same-origin proxy.
    if (!authorized(req)) return json(res, 401, { error: 'Bridge認証が必要です' });
    try {
      if (req.method === 'GET' && req.url === '/api/tts/health') {
        const response = await fetchImpl(`${upstream}/health`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return json(res, 503, { error: 'TTSサーバーに接続できません' });
        const health = await response.json();
        return json(res, 200, { status: health.status, loaded: health.runtime?.loaded === true });
      }
      if (req.method === 'GET' && req.url === '/api/tts/profiles') {
        return json(
          res,
          200,
          Object.entries(profiles).map(([id, p]) => ({
            id,
            name: p.name ?? id,
            revision: p.revision,
            styles: Object.keys(p.styles ?? {}),
          }))
        );
      }
      if (req.method === 'POST' && req.url === '/api/tts/voices') {
        if (!(req.headers['content-type'] ?? '').startsWith('audio/wav'))
          return json(res, 415, { error: 'WAVが必要です' });
        let bytes = 0;
        const parts = [];
        for await (const part of req) {
          bytes += part.length;
          if (bytes > MAX_BYTES) return json(res, 413, { error: '参照音声が大きすぎます' });
          parts.push(part);
        }
        const wav = Buffer.concat(parts);
        try {
          wavDuration(wav);
        } catch (error) {
          return json(res, 400, { error: error.message });
        }
        const id = `axe-${createHash('sha256').update(wav).digest('hex')}`;
        const form = new FormData();
        form.set('voice_id', id);
        form.set('file', new Blob([wav], { type: 'audio/wav' }), `${id}.wav`);
        const response = await fetchImpl(`${upstream}/v1/audio/voices`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok && response.status !== 409) {
          await response.body?.cancel();
          return json(res, 502, { error: `参照音声の登録に失敗しました（TTS HTTP ${response.status}）` });
        }
        await response.body?.cancel();
        return json(res, 200, { id });
      }
      if (req.method !== 'POST' || req.url !== '/api/tts/synthesize') return json(res, 404, { error: 'Not found' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
        return json(res, 415, { error: 'JSONが必要です' });
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) return json(res, 413, { error: '要求が大きすぎます' });
        chunks.push(chunk);
      }
      let body, resolved;
      try {
        body = JSON.parse(Buffer.concat(chunks));
        resolved = resolveRequest(body, profiles);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      const fingerprint = createHash('sha256').update(resolved.json).digest('hex');
      for (const [id, job] of jobs) if (job.finished && Date.now() - job.finished > 90000) jobs.delete(id);
      let job = jobs.get(body.requestId);
      if (job && job.fingerprint !== fingerprint)
        return json(res, 409, { error: 'requestId の再利用内容が異なります' });
      if (!job) {
        if (pending >= 10 || jobs.size >= 200) return json(res, 429, { error: '生成キューが満杯です' });
        pending++;
        job = { fingerprint, finished: 0, bytes: 0, received: Date.now() };
        job.promise = tail
          .then(async () => {
            if (Date.now() - job.received >= 90000) throw new Error('生成待機の期限切れ');
            const response = await fetchImpl(`${upstream}/v1/audio/speech`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: resolved.json,
              signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) {
              await response.body?.cancel();
              throw new Error(`TTS HTTP ${response.status}`);
            }
            const wav = await readLimited(response);
            job.bytes = wav.length;
            return { wav, durationMs: wavDuration(wav), revision: resolved.revision };
          })
          .finally(() => {
            pending--;
            job.finished = Date.now();
          });
        tail = job.promise.catch(() => undefined);
        jobs.set(body.requestId, job);
      }
      const result = await job.promise;
      if (res.destroyed) return;
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': result.wav.length,
        'X-TTS-Duration-Ms': String(result.durationMs),
        'X-TTS-Profile-Revision': result.revision,
      });
      res.end(result.wav);
      // Bound cached results by total WAV size; keep failed request IDs to prevent blind retries.
      let total = 0;
      for (const cached of [...jobs.values()].reverse()) {
        if (!cached.finished) continue;
        total += cached.bytes;
        if (total > 128 * 1024 * 1024) {
          cached.bytes = 0;
          cached.promise = Promise.reject(new Error('結果キャッシュの期限切れ'));
        }
        cached.promise.catch(() => undefined);
      }
    } catch (error) {
      if (!res.destroyed) json(res, 502, { error: error.name === 'TimeoutError' ? '生成タイムアウト' : error.message });
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const profiles = JSON.parse(
    readFileSync(process.env.TTS_PROFILES ?? new URL('./profiles.json', import.meta.url), 'utf8')
  );
  const server = createBridge({
    token: process.env.TTS_BRIDGE_TOKEN,
    profiles,
    upstream: process.env.TTS_UPSTREAM ?? 'http://127.0.0.1:8088',
  });
  server.listen(Number(process.env.TTS_BRIDGE_PORT ?? 8090), '127.0.0.1', () =>
    console.log('TTS Bridge: http://127.0.0.1:8090')
  );
}
