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

   Node.js 22.13以上が必要。既定の管理画面は`http://127.0.0.1:8090/admin/`、Playerは`http://127.0.0.1:8090/player/`。初回起動後、`trpg-voice-bridge/tts-bridge/data/credentials.json`にある`admin`と`collector`のトークンを確認する。

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

4. **管理画面で読み上げを開始し、入力元を登録する**

   `http://127.0.0.1:8090/admin/`を開き、`admin`トークンを入力して「読み上げ開始」を押す。入力元IDは自分で決める識別子。部屋・ワールドIDはFVTTなら`game.world.id`（デモでは確認時`foundry-demo`）、ユドナリウム系なら部屋IDを入力する。

5. **FVTTや、ユドナにログイン・入室し、拡張機能の設定をする**

   ログイン・入室したら、Chromeブラウザの拡張機能の「TRPG Voice Collector」を開き、設定を行う。

   - Bridge URL : TRPG Voice Bridge のサーバURLを入力（例 : `http://127.0.0.1:8090`）
   - Collector トークン : あらかじめ控えておいたCollectorトークンを入力
   - ツール : FVTT かユドナか選択
   - 入力元ID : 管理画面で設定した識別子を入力
   - 部屋・ワールドID : FVTTの場合は `game.world.id`の値を、ユドナの場合は部屋IDを入力
   - 対象チャット : FVTTの場合は `main`、ユドナの場合は `MainTab` や `SubTab`, `SystemTab`など

   入力し終わったら「このタブを接続」を押す。

6. **管理画面で「参加URLを発行」する**

   発行されたURLを卓参加者に伝える。`127.0.0.1`のURLは同じPCからの確認用。外部公開では手順2の`TTS_PUBLIC_ORIGIN`を設定してから発行し、URLを手で書き換えない。

### 卓参加者の開始手順（音声生成担当も含む）

7. **発行された参加URLを別タブで開き、「音声を有効にする」を押す**

8. **指定したタブのチャットでキャラクターとして発言する**

   FVTTでは「Public as Character」を選ぶ。初めてのキャラは最初の発言が管理画面の「未登録の発言者」に出る。音声生成担当が声を紐付けた後、**次の発言から**音声が再生される。

