import { check, HttpError } from "./contracts.mjs";

// The upstream /speech/ API is private to its web UI. Keep its contract here,
// separately from Irodori's persistent /v1/audio/voices API.
export async function ttsJson(response, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  try {
    for await (const part of response.body ?? []) {
      size += part.length;
      check(size <= limit, "TTS応答が大きすぎます", 502);
      chunks.push(part);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

export async function speechModel(provider, fetchImpl = fetch, signal) {
  const r = await fetchImpl(`${provider.baseUrl}/v1/models`, {
    signal: AbortSignal.any([
      AbortSignal.timeout(5000),
      ...(signal ? [signal] : []),
    ]),
  });
  check(r.ok, `TTSモデル一覧の取得失敗（HTTP ${r.status}）`, 502);
  const data = await ttsJson(r);
  const model = data.data?.find((m) => m.speech?.task === "synthesis");
  check(
    model && typeof model.id === "string" && Array.isArray(model.speech.voices),
    "TTSの音声合成モデルが準備されていません",
    503,
  );
  return model;
}

export async function remoteVoices(provider, fetchImpl, signal) {
  if (provider.type === "mock")
    return { voices: [{ id: "none", no_ref: true }] };
  if (provider.type === "speech") {
    const model = await speechModel(provider, fetchImpl, signal);
    return {
      model,
      voices: model.speech.voices.map((v) => ({
        id: v.name,
        no_ref: v.name === "none",
      })),
    };
  }
  const r = await fetchImpl(`${provider.baseUrl}/v1/audio/voices`, {
    signal: AbortSignal.any([
      AbortSignal.timeout(5000),
      ...(signal ? [signal] : []),
    ]),
  });
  check(r.ok, "参照voice一覧の取得失敗", 502);
  const data = await ttsJson(r);
  check(Array.isArray(data.data), "参照voice一覧の形式が不正です", 502);
  return { voices: data.data.map((v) => ({ id: v.id, no_ref: v.no_ref })) };
}

export async function uploadVoice(provider, voiceId, wav, fetchImpl, signal) {
  const speech = provider.type === "speech";
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), `${voiceId}.wav`);
  form.append(speech ? "name" : "voice_id", voiceId);
  const r = await fetchImpl(
    `${provider.baseUrl}${speech ? "/speech/voices" : "/v1/audio/voices"}`,
    {
      method: "POST",
      body: form,
      signal: AbortSignal.any([
        AbortSignal.timeout(180000),
        ...(signal ? [signal] : []),
      ]),
    },
  );
  let problem;
  if (!r.ok) {
    try {
      problem = (await ttsJson(r, 8192)).error;
    } catch {
      /* retain HTTP status */
    }
  } else await r.body?.cancel();
  const duplicate =
    (r.status === 409 &&
      problem?.code !== "model_not_found" &&
      problem?.code !== "model_loading") ||
    (r.status === 400 &&
      problem?.param === "name" &&
      problem?.code === "invalid_value" &&
      /already (?:a voice|exists)|name.*already/i.test(problem.message ?? ""));
  if (r.ok) return;
  // Only recognized, pre-registration rejections permit undoing a new local
  // save. A generic HTTP error (including 5xx from a proxy) is ambiguous.
  const notRegistered = speech
    ? (r.status === 404 && problem?.code === "page_off") ||
      (r.status === 403 &&
        ["host_not_allowed", "origin_not_allowed"].includes(problem?.code)) ||
      (r.status === 400 &&
        problem?.param === "name" &&
        problem?.code === "invalid_value") ||
      (r.status === 400 &&
        problem?.param === "file" &&
        problem?.code === "missing_required_parameter") ||
      (r.status === 409 && problem?.code === "model_not_found")
    : r.status === 409 && problem?.code === "voice_exists";
  const error = new HttpError(
    duplicate ? 409 : 502,
    duplicate
      ? "同じIDの参照音声が既にあります。別のIDにしてください"
      : speech && problem?.code === "page_off"
        ? "参照音声の登録にはspeech.cppを127.0.0.1で起動してください。別のPCでは同じポートのSSH転送を利用できます"
        : speech && problem?.code === "host_not_allowed"
          ? "speech.cppの登録先ホスト・ポートが一致していません。SSH転送は両端を同じポートにしてください"
          : `参照音声の登録に失敗しました（TTS HTTP ${r.status}）`,
  );
  error.notRegistered = Boolean(notRegistered);
  throw error;
}
