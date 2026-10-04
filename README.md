# TRPG Voice Bridge

FVTTやユドナリウムなどのVTTから音声担当者（GMまたはPL）のブラウザ拡張で公開発言を取り込み、Irodoriで一度だけ生成して、参加者のブラウザへ同じ音声を配るためのシステムです。

![TRPG Voice Bridgeのコンポーネント図](./compornent.png)

**現時点では共通基盤とFVTT取得の実装段階です。FVTTやユドナリウム、ココフォリアなどのVTTすべてに対応した完成版ではありません。** FVTT 14.365 / PF2e 8.3.0は実機確認済み、12/13はフックのfixture試験まで、通常版ユドナリウムは取得条件を満たす環境に限る実験実装、ココフォリアは安全な取得方法の検証待ちで実装を中断しています。

キャラの声はPlayerで全員が設定できます。Collectorの初回承認と読み上げ開始・停止は管理画面で行います。

- [Quick Start](quickstart.md)
- 詳細情報
  - [接続図・Collectorの説明・セットアップ](docs/setup-guide.md)
  - [起動・設定の詳細](tts-bridge/README.md)
  - [HTTPS公開設定例](docs/online.md)

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
