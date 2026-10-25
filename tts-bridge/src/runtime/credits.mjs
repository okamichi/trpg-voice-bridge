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
      note: "内蔵TTSに使っています。参照音声の保存・復元はBridgeが行います。",
      license: speechLicense,
    });
  return {
    entries,
    footer: speechLicense
      ? "ほかに同梱しているソフトウェアのライセンスは、展開したフォルダのlicensesとruntime/speechにあります。"
      : "",
  };
}
