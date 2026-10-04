# TRPG Voice Bridge

FVTTやユドナリウムなどのVTTから音声担当者（GMまたはPL）のブラウザ拡張で公開発言を取り込み、Irodori-TTS-Server で発言テキストの音声生成を動的に行って、参加者のブラウザへ同じ音声を配るためのシステムです。

![TRPG Voice Bridgeのコンポーネント図](./compornent.png)

キャラの声はPlayerで全員が設定できます。Collectorの初回承認と読み上げ開始・停止は管理画面で行います。

- [Quick Start](quickstart.md)
- 詳細情報
  - [接続図・Collectorの説明・セットアップ](docs/setup-guide.md)
  - [起動・設定の詳細](tts-bridge/README.md)
  - [HTTPS公開設定例](docs/online.md)

## Irodori-TTS-Server について

音声の生成には[Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server)を使います。日本語音声合成モデル[Irodori-TTS](https://github.com/Aratako/Irodori-TTS)を、OpenAIのText-to-Speech API互換で提供するサーバーです。Bridgeと同じマシンで`127.0.0.1:8088`に起動する構成を標準にしています（[Quick Start](quickstart.md)）。

Bridgeが使うIrodoriの機能は次のとおりです。

- **声の説明文による声づくり（Voice Design）**: 「落ち着いた年配の男性の声」のような説明文（caption）とseedで声を作ります。参照音声がなくても、キャラごとに声を作り分けられます。
- **参照音声による声の固定**: 参照音声を指定すると、その声質に寄せて生成します。Playerで試聴した声を、そのまま参照音声として登録できます。
- **発言ごとの演技指示**: 発言に書いた演技指示を説明文に加えて生成します。

### 推奨モデル

| モデル | ライセンス | 特徴 |
| :--- | :--- | :--- |
| [Aratako/Irodori-TTS-v4.1-Small](https://huggingface.co/Aratako/Irodori-TTS-v4.1-Small) | MIT | 標準的な小型モデル。生成が速く、手元のGPUやApple Siliconでも扱いやすいです。 |
| [phasefield-audio/Irodori-TTS-v4.1-Anime](https://huggingface.co/phasefield-audio/Irodori-TTS-v4.1-Anime) | MIT | v4.1-Smallをアニメ調の音声で追加学習したモデル。キャラクターらしい演技に向きます。説明文や絵文字の効き方はベースモデルと異なる場合があります。 |
| [Aratako/Irodori-TTS-v4-Large](https://huggingface.co/Aratako/Irodori-TTS-v4-Large) | Gemma | 約3.29Bパラメーターの大型モデル。説明文への追従性が高い一方、多くのメモリと生成時間が必要です。 |

ライセンスはモデルごとに異なります。v4-LargeはGemmaの利用規約に従います。

量子化版もあります。v4.1-Animeはリポジトリ内のサブフォルダーに、v4-Largeは[Aratako/Irodori-TTS-v4-Large-Quantized](https://huggingface.co/Aratako/Irodori-TTS-v4-Large-Quantized)に収録されています。量子化版はおもにNVIDIA CUDA向けです。

Apple Siliconで動かす場合は、MLXハイブリッド推論を追加したフォーク[okamichi/Irodori-TTS-Server](https://github.com/okamichi/Irodori-TTS-Server)の`mlx`ブランチを用意しています。

## スクリーンショット

### /player 卓音声再生・キャラ声紐付けページ

参加者が音声を聞き、キャラの声を設定する画面です。

![Player画面](./trpg-voice-bridge-player.png)

### /admin 管理ページ

接続状態の確認、読み上げの開始・停止、参加URLの発行などを行います。

![管理画面](./trpg-voice-bridge-admin.png)

### ブラウザ拡張（Collector）

音声担当者のChromeに読み込んだCollector拡張と、VTTのサイトへのアクセスが許可されている状態です。

![Chromeの拡張機能ページに読み込んだCollector](./trpg-voice-bridge-extension.png)

![VTTのサイトでアクセスが許可されたCollector](./trpg-voice-bridge-collector.png)

## ライセンス

MITライセンスです。全文は[LICENSE](LICENSE)を参照してください。
