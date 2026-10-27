export function credits(bridgeLicense, speechLicense, speech) {
  const entries = [
    {
      title: "TRPG Voice Bridge",
      url: "https://github.com/okamichi/trpg-voice-bridge",
      linkText: "okamichi/trpg-voice-bridge",
      license: bridgeLicense,
    },
  ];
  if (speechLicense)
    entries.push({
      title: "speech.cpp",
      url: `https://github.com/${speech.repository.replace(/\.git$/, "")}/tree/${speech.commit}`,
      linkText: `${speech.repository}（${speech.commit.slice(0, 7)}）`,
      note: "内蔵の音声合成（TTS）と文字起こし（STT）に使っています。参照音声の保存・復元はBridgeが行います。",
      license: speechLicense,
    });
  for (const [title, repository, license] of [
    ["Qwen3-ASR-0.6B", "Qwen/Qwen3-ASR-0.6B", "Apache License 2.0"],
    ["Qwen3-ASR-1.7B", "Qwen/Qwen3-ASR-1.7B", "Apache License 2.0"],
    [
      "ReazonSpeech v2",
      "reazon-research/reazonspeech-nemo-v2",
      "Apache License 2.0",
    ],
    [
      "Parakeet TDT-CTC 0.6B (ja)",
      "nvidia/parakeet-tdt_ctc-0.6b-ja",
      "Creative Commons Attribution 4.0 International (CC BY 4.0)",
    ],
  ])
    entries.push({
      title,
      url: `https://huggingface.co/${repository}`,
      linkText: repository,
      note: "文字起こし用の選択モデルです。モデルは別途ダウンロードします。speech.cpp用にGGUFへ変換・量子化されたモデルを使用します。配布元のモデルカードとライセンスを確認してください。",
      license,
    });
  return {
    entries,
    footer: speechLicense
      ? "ほかに同梱しているソフトウェアのライセンスは、展開したフォルダのlicensesとruntime/speechにあります。"
      : "",
  };
}
