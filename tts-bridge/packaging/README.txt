TRPG Voice Bridge — ポータブルプレビュー

speech.cppを同梱しています。モデルは別途用意してください。Bridgeはモデルを自動ダウンロードしません。
初期設定は外部Irodori互換TTSへの接続です。管理画面で内蔵TTSとGGUFの絶対パスを保存し、Bridgeを再起動してください。
Node.js / npmのインストールは利用者には不要です。
trpg-voice-bridgeとruntime/、collector/を同じ配置のまま保管してください。

モデルの取得（例: Irodori-TTS v4.1 Small のQ8_0、約1.2GB）:
  macOS: SPEECH_MODEL_DIR="$PWD/models" ./runtime/speech/speech pull irodori-tts:q8_0
  完了すると保存したGGUFの絶対パスを表示します。管理画面の「GGUFモデルの絶対パス」に貼り付けてください。
  SPEECH_MODEL_DIRを省略すると、OSのキャッシュフォルダへ保存します。
  ほかのモデルは ./runtime/speech/speech models で一覧できます。
  irodori-tts-large（Irodori-TTS v4-Large）はGemmaの利用規約に従います。

起動:
  macOS: ターミナルで ./trpg-voice-bridge
  Windows: trpg-voice-bridge.exe
管理画面が標準ブラウザで開きます。終了は管理画面の「Bridgeを終了」か、起動した端末でCtrl+C。
自動で開けない場合は端末から --no-browser を付けて起動し、表示した管理用リンクを開きます。
管理用リンクは共有しないでください。出力をファイルへリダイレクトするとリンクは表示しません。

オプション:
  --help / --version
  --data-dir <path>     設定・DB・生成音声の保存先
  --port <1-65535>      Bridge待受ポート（既定8090）
  --tts <external|bundled>  今回だけ起動方式を指定
  --model <absolute.gguf>   今回だけGGUFモデルの絶対パスを指定
  --tts-port <1-65535>      今回だけ内蔵TTSポートを指定（既定18088）
  --tts-backend <vulkan|cpu>  Windowsで今回だけ内蔵TTSの種類を指定
  --no-browser         管理画面を手動で開く
  --self-test          SQLite・Discord依存・PCM→Opus変換の診断（通信しません）

既定の保存先:
  macOS: ~/Library/Application Support/TRPG-Voice-Bridge/data/
  Windows: %LOCALAPPDATA%\TRPG-Voice-Bridge\data\
runtime.jsonに起動方式・モデルパス・TTSポートを保存します。CLI指定は保存値を上書きしません。
内蔵TTSは127.0.0.1だけで待ち受け、参照音声はdata-dirのvoices/へ保存します。
内蔵TTSの起動失敗時も管理画面は利用できます。モデル・ポートを修正し、終了後に再起動してください。
外部TTSの接続先URLは内蔵モードでも保持されます。
バックアップ・移行はBridge終了後にdata-dir全体をコピーしてください。モデルは移動先で別途指定します。
外部TTSから声を移す場合は、両TTSを停止し、ID.wavをvoices/へコピーして同じ参照音声IDを使います。
上書き前にバックアップを取り、移行元のファイルを残して試聴で確認してください。
外部TTSの参照音声はTTSサーバー側で保存・バックアップしてください。
既存データは自動移行しません。同じ保存先のBridgeは同時に1つだけ起動でき、2つ目は起動を拒否します。
TTS_DATA_DIR / TTS_BRIDGE_PORT / TTS_CONFIG_FILE 等の既存環境変数も利用できます。

Collector:
  Chromeの拡張機能管理でデベロッパーモードを有効にし、
  「パッケージ化されていない拡張機能を読み込む」でcollectorフォルダを選択します。

macOS版はAppleによる公証を受けていません。Windows版はコード署名がありません。
初回起動時にOSの確認や警告が表示される場合があります。

macOSで開発元を確認できない旨の警告が出た場合:
  入手元と同梱のSHA-256を確認し、起動を試した後で、
  「システム設定」→「プライバシーとセキュリティ」の「このまま開く」を確認してください。
  Bridgeだけでなく、runtime/speech内のspeechやbridge-supervisor、ネイティブ依存にも
  確認が必要な場合があります。
  Appleの案内: https://support.apple.com/ja-jp/102445
