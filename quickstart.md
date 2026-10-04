# TRPG Voice Bridgeでの音声再生のクイックスタート

### 音声生成担当の準備手順

1. **Irodori-TTS-Serverを起動する**

   ```sh
   git clone https://github.com/Aratako/Irodori-TTS-Server.git
   cd Irodori-TTS-Server
   uv run --no-sync python -m irodori_openai_tts --host 127.0.0.1 --port 8088
   ```

   初回はIrodori-TTS-ServerのREADMEに従い、使用する環境向けの依存関係を導入してから起動する。

2. **TRPG Voice Bridgeを起動する**（別のターミナル）

   ```sh
   git clone https://github.com/okamichi/trpg-voice-bridge.git
   cd trpg-voice-bridge/tts-bridge
   npm ci
   npm start
   ```

   Node.js 22.13以上が必要。起動ログに表示される**管理用リンク**を開く。このリンクは共有しない。

   卓参加者はインターネットごしに音声再生URLへアクセスするため、`127.0.0.1`などのローカルアドレスではアクセスできない。そのため、リバースプロキシなどを使ってHTTPSで公開することを推奨する（[公開手順](docs/online.md)参照）。公開する場合は例えば、次のように環境変数でホストやポート番号、公開用ドメインを指定して起動する。

   ```sh
   export TTS_BRIDGE_HOST=0.0.0.0
   export TTS_BRIDGE_PORT=8090
   export TTS_PUBLIC_ORIGIN=https://voice.example.com
   npm start
   ```

3. **Chromeブラウザの拡張機能をインストールする**

   `chrome://extensions/`で「デベロッパーモード」をオンにし、「パッケージ化されていない拡張機能を読み込む」から`trpg-voice-bridge/tts-bridge/collector`を選ぶ。

### 音声生成担当の開始手順

4. **管理用リンクを開き、Irodoriの接続状態を確認する**

   接続先を変更する場合は「詳細設定」の「接続先URL」で変更する。読み上げは停止したままでよい。

5. **FVTTや、ユドナにログイン・入室し、拡張機能を接続する**

   VTTのタブで「TRPG Voice Collector」を開き、「このタブを接続」を押す。

   - ツール・入力元ID・FVTTのワールドID・対象チャットは自動取得する。
   - ユドナでは読み上げたい公開チャットを表示し、「部屋の識別名」を入力する。同じ卓では次回も同じ名前を使う。取得できない対象チャットだけ手入力する（例：`MainTab`）。
   - Bridgeのポートを変えた場合は「Bridge接続先」を変更する。
   - 初回は確認コードが表示される。管理画面で同じコードを「承認」し、VTTの拡張へ戻って「このタブを接続」を押す。次回から承認は不要。

6. **管理画面で「参加URLをコピー」し、卓参加者に伝える**

   音声生成担当は「Playerを開く」で参加できる。`127.0.0.1`のURLは同じPCからの確認用。外部公開では手順2の`TTS_PUBLIC_ORIGIN`を指定し、URLを手で書き換えない。

### 卓参加者の開始手順（音声生成担当も含む）

7. **参加URLを別タブで開き、「音声を有効にする」を押す**

8. **キャラとして公開発言し、Playerで声を選ぶ**

   FVTTでは「Public as Character」を選ぶ。最初の発言でPlayerの「キャラの声」に表示される。「声を選ぶ」で声を選択し、試聴して「保存」する。全員が他のキャラも設定でき、試聴は操作した本人だけに聞こえる。

9. **音声生成担当が管理画面で「読み上げ開始」を押す**

   以後の新しい発言を読み上げる。停止中・声未設定時の発言は後から再生しない。「読み上げ停止」は再生中の音声と保留分も止める。
