# ソースからのビルドと起動

リリースに含まれるソース（Source code）からTRPG Voice Bridgeを起動し、VTTの発言を読み上げるまでの手順です。

## 1. 進め方を選ぶ

|            | A. `npm start` で起動する                                       | B. 実行ファイルを作って起動する                                      |
| ---------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| 音声生成   | 別に起動した外部TTS（Irodori-TTS-Serverかspeech.cpp）に接続する | speech.cppを同梱する。管理画面で内蔵TTSと外部TTSを切り替えられる     |
| 必要なもの | Node.js 22.13以上                                               | Node.js 24.22.1、CMake、C++のビルド環境（macOS arm64 / Windows x64） |
| 読む節     | 2 → 4 → 6（外部TTSにspeech.cppを使う場合は3も）                 | 2 → 3 → 5 → 6                                                        |

`npm start` で開いた管理画面には、内蔵TTSの設定（「TTSの起動設定」）は表示されません。内蔵TTSを使う場合はBを選んでください。

## 2. ソースを用意する

リリースページの「Source code (zip)」を展開するか、`git clone` で取得します。

```sh
git clone https://github.com/okamichi/trpg-voice-bridge.git
cd trpg-voice-bridge/tts-bridge
npm ci
```

ZIPを使う場合は、展開したフォルダの中の `tts-bridge/` に移動してから `npm ci` を実行してください。

AでDiscord Botを使う場合は、Discord用の依存も入れます。Bでは要りません。実行ファイルを作る処理が、Discord用の依存を実行ファイルの `runtime/discord/` に入れるためです。

```sh
npm --prefix discord ci
```

以降のコマンドは、断りがなければ `tts-bridge/` で実行します。WindowsではPowerShellを使ってください。Collectorを入れるためにChromeも必要です。

Bでは、Node.jsについて次の2点も必要です。

- 版は [`packaging/node-version`](../tts-bridge/packaging/node-version) の **24.22.1** と同じにしてください。違う版ではビルドが止まります。
- nodejs.orgの公式配布物を使ってください。ビルドは、Node.js本体と一緒にある `LICENSE` をパッケージへコピーします。見つからないとビルドが止まります。

## 3. speech.cppをビルドする

Bと、Aでspeech.cppを外部TTSに使う場合に必要です。ビルドできるのは、次の2つの環境で、その環境向けのものだけです。

| OS                     | 必要なもの                                                                                          | できるspeech.cpp |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ---------------- |
| macOS（Apple Silicon） | Xcode Command Line Tools、CMake 3.20以上                                                            | Metal版          |
| Windows（x64）         | Visual Studio（またはBuild Tools）のC++ビルド環境とWindows SDK、ClangCL、CMake 3.20以上、Vulkan SDK | CPU版とVulkan版  |

macOSでは、Command Line Toolsを入れていなければ次で入れます。CMakeも入れて、ターミナルから `cmake` を使えるようにしてください。

```sh
xcode-select --install
```

Windowsでは、Visual Studio Installerで「C++によるデスクトップ開発」とClangCLを入れます。Vulkan版も必ずビルドするので、CPU版だけを使う場合も [Vulkan SDK](https://vulkan.lunarg.com/sdk/home) が必要です。リリースのビルドには1.4.357.0を使っています。SDKを入れたら、新しいPowerShellで、実際のインストール先を指定します。

```powershell
$env:VULKAN_SDK = 'C:\VulkanSDK\1.4.357.0'
$env:PATH = "$env:VULKAN_SDK\Bin;$env:PATH"
cmake --version
```

準備ができたら、ビルドします。

```sh
npm run package:speech
```

[`packaging/speech-lock.json`](../tts-bridge/packaging/speech-lock.json) で指定したspeech.cppとggmlのソースをダウンロードし、SHA-256を確かめてからビルドします。speech.cppを別にcloneする必要はありません。

できたファイルは `tts-bridge/.packaging/speech-runtime/` に置かれます。

| OS      | 主なファイル                                                                    |
| ------- | ------------------------------------------------------------------------------- |
| macOS   | `speech`、`bridge-supervisor`                                                   |
| Windows | `speech.exe`（CPU版）、`speech-vulkan.exe`（Vulkan版）、`bridge-supervisor.exe` |

`bridge-supervisor` は、内蔵TTSの起動と終了を管理し、同じ保存先でBridgeが二重に起動しないようにするプログラムです。

## 4. A: 外部TTSに接続して起動する

外部TTSは、Bridgeとは別に起動するTTSです。同じPCで動かしてもかまいません。次のどちらかを、Bridgeとは別のターミナルで起動してください。

### Irodori-TTS-Serverを使う

```sh
git clone https://github.com/Aratako/Irodori-TTS-Server.git
cd Irodori-TTS-Server
uv sync --extra cu128
cp .env.example .env
uv run --no-sync python -m irodori_openai_tts --host 127.0.0.1 --port 8088
```

- `cu128` はNVIDIA CUDAの例です。LinuxのAMD ROCmなら `rocm`、CPUなら `cpu` にしてください。指定するのはどれか一つです。
- `.env` でのモデルの設定や、環境ごとの準備は [Irodori-TTS-ServerのREADME](https://github.com/Aratako/Irodori-TTS-Server#installation) を見てください。初回はモデルの取得と読み込みに時間がかかります。
- Apple SiliconでMLXを使う場合は、[MLX対応フォークのmlxブランチ](https://github.com/okamichi/Irodori-TTS-Server/tree/mlx)の手順に従ってください。

### speech.cppを使う

3節でビルドしたspeech.cppを、そのまま外部TTSとして使えます。実行ファイルを作る必要はありません。`tts-bridge/` で、まずモデルをダウンロードします。

```sh
# macOS
./.packaging/speech-runtime/speech pull irodori-tts:q8_0
```

```powershell
# Windows
.\.packaging\speech-runtime\speech.exe pull irodori-tts:q8_0
```

最後に表示されるGGUFの絶対パスを、次の `<GGUFの絶対パス>` に入れて起動します。

```sh
# macOS
./.packaging/speech-runtime/speech serve "<GGUFの絶対パス>" --host 127.0.0.1 --port 8088
```

```powershell
# Windows（CPU版）
.\.packaging\speech-runtime\speech.exe serve '<GGUFの絶対パス>' --host 127.0.0.1 --port 8088
```

- WindowsでVulkan版を使う場合は、`speech-vulkan.exe` に替えて `--device gpu` を付けてください。
- 管理画面の「TTS接続先」で「speech.cpp（本家）」を選んでください。参照音声はBridgeの保存先の `voices/` と `reference-voices.json` で管理し、TTS再起動後は不足分を再登録します。
- 別PCの本家を利用する場合は、両端が同じポートのSSH転送を使います（例: `ssh -N -L 8088:127.0.0.1:8088 user@tts-host`）。
- macOS arm64とWindows x64以外では、[nyosegawa/speech.cpp](https://github.com/nyosegawa/speech.cpp) の手順でビルドしてください。

### Bridgeを起動する

TTSを動かしたまま、別のターミナルの `tts-bridge/` で起動します。

```sh
npm start
```

1. 端末に表示される**管理用リンク**を開きます。このリンクは共有しないでください。出力をファイルへリダイレクトすると、リンクは表示されません。
2. 「1 TTSの準備」の「接続テスト」を押し、「接続状態」のTTSサーバーが「接続済み」になることを確かめます。

接続先の既定は `http://127.0.0.1:8088` です。「TTS接続先」で種類を選び、別のアドレスやポートで起動した場合はURLも変えて「接続先を保存」を押してください。外部TTSの起動・停止・モデルの変更は、そのTTSを起動した端末で行います。

続けて6節へ進んでください。

## 5. B: 実行ファイルを作って起動する

外部TTSだけを使う場合も、実行ファイルにはspeech.cppが入ります。先に3節を済ませてください。

### 実行ファイルとZIPを作る

```sh
npm test
npm run package:build
npm run package:smoke
```

`package:build` が実行ファイルとZIPを作り、`package:smoke` がそのZIPを展開して起動と終了を確かめます。

| OS      | 実行ファイルのあるフォルダ      | ZIP                                                            |
| ------- | ------------------------------- | -------------------------------------------------------------- |
| macOS   | `tts-bridge/dist/darwin-arm64/` | `tts-bridge/dist/trpg-voice-bridge-<version>-darwin-arm64.zip` |
| Windows | `tts-bridge/dist/win32-x64/`    | `tts-bridge/dist/trpg-voice-bridge-<version>-win32-x64.zip`    |

`<version>` は `tts-bridge/package.json` のバージョンです。ZIPのSHA-256は、同じ名前の `.zip.sha256` に書かれます。ZIPを展開すると `TRPG-Voice-Bridge/` フォルダがあります。中の実行ファイル・`runtime/`・`collector/`・`chatter/` は、配置を変えずに使ってください。ZIPを受け取って使う人には、Node.js・CMake・Vulkan SDKは要りません。

### 起動する

例では、データを `tts-bridge/data-bundled/` に保存します。`npm start` の保存先（`tts-bridge/data/`）とは別なので、以前のキャラや声は見えません。

```sh
# macOS
./dist/darwin-arm64/trpg-voice-bridge --data-dir ./data-bundled
```

```powershell
# Windows
.\dist\win32-x64\trpg-voice-bridge.exe --data-dir ./data-bundled
```

管理画面がブラウザで開きます。開かない場合は `--no-browser` を付けて起動し直し、表示された管理用リンクを開いてください。

### 内蔵TTSを設定する

最初は外部TTSに接続する設定（起動方式「外部サーバー」）で起動します。内蔵TTSに切り替えるには、次のようにします。

1. 「1 TTSの準備」→「TTSの起動設定」の「起動方式」で、macOSは「内蔵speech.cpp」を、Windowsは「内蔵speech.cpp（Vulkan）」か「内蔵speech.cpp（CPU）」を選びます。
2. 「一覧からダウンロード」の「モデル」を選び、「ダウンロードして使う」を押します。終わると「GGUFモデルの絶対パス」にパスが入ります。手元のGGUFを使う場合は、その絶対パスを入力します。
3. 「次回起動の設定を保存」を押し、表示される「Bridgeを再起動」を押します。
4. 再起動して管理画面が開き直されたら、「1 TTSの準備」が「準備完了」になるのを待ちます。

- モデルの保存先は「保存先」で変えられます。Bridgeのデータの保存先とは別です。
- 内蔵TTSのポートの既定は **18088** です。Bridgeの8090や、4節の例の8088とは別です。
- Windowsのspeech.cppはAVX2に対応したCPUが必要です。Vulkan版には、Vulkanに対応したGPUとドライバーも必要です。Vulkan版でエラーになる場合は、CPU版にして保存し、「Bridgeを再起動」を押してください。CPU版は生成に時間がかかることがあります。
- 外部TTSに戻すには、起動方式を「外部サーバー」にして保存し、「Bridgeを再起動」を押します。「TTS接続先」の設定は残っています。

## 6. 管理画面で卓の準備をする

ここからはAとBで同じです。管理画面の手順は、設定する順に番号が付いています。

### Discord Botを使う場合

1. [Discordでの利用方法](discord.md)に従ってBotを作り、Discordのサーバーへ招待します。
2. 「2 Discord Bot」で「Discord Botに接続する」をオンにし、Botトークンを入れて「保存してログイン」を押します。
3. 「ボイスチャンネル」を選び、「接続」を押します。

Aでは、2節の `npm --prefix discord ci` が必要です。Discordで聞く参加者は、Playerの音声を有効にしないでください。

### チャットのないVTTでChatterを使う

D&D Beyond の MapsVTT のようなチャット機能の無いシステムでも、Chromeの拡張機能でブラウザのサイドエリアで簡易チャット機能を追加できます。

この場合は管理画面の担当者に次項の Collector は不要で、代わりに参加者全員が拡張機能の Chatter をインストールして Bridge サーバとの接続を行います。Aでは `npm run chatter:build` を実行し、Chromeに `tts-bridge/chatter/` を読み込みます。Bでは配布物の `chatter/` がビルド済みなので、そのまま読み込めます。導入と参加は[Chatterの手順](../tts-bridge/chatter/README.md)を参照してください。拡張が不要なら参加URLからPlayerを開いてチャットできます。

### Collectorを入れて接続する

Collectorは、VTTのチャットを取得するChrome拡張です。同じチャットに対して、Collectorを入れる担当者を一人決めてください。参加者全員が入れる必要はありません。

1. Chromeで新しいタブを開き、アドレスバーに `chrome://extensions` を入力して開きます。「3 Collectorの接続」の「コピー」でもコピーできます。
2. 右上の「デベロッパーモード」をオンにし、「パッケージ化されていない拡張機能を読み込む」で `collector` フォルダを選びます。
   - A：`tts-bridge/collector/`
   - B：実行ファイルと同じフォルダの `collector/`（例：`tts-bridge/dist/darwin-arm64/collector/`）
3. VTTに入室してチャットを開き、そのタブで拡張の「TRPG Voice Collector」を開いて「このタブを接続」を押します。
4. 初回は、拡張に確認コードが表示されます。管理画面の「Collectorの初回接続を承認」で同じコードを承認し、拡張で「このタブを接続」をもう一度押します。
5. 「接続状態」のCollectorが「接続中」になれば完了です。

Bridgeのポートを変えた場合は、拡張の「Bridge接続先」も変えてください。VTTごとの取得の条件は[セットアップガイド](setup-guide.md#collectorとは)を見てください。拡張を更新したら、Chromeの拡張機能の画面で再読み込みし、VTTのタブから接続し直します。

### 声を設定して読み上げを始める

1. 「4 卓の開始」の「Playerを開く」でPlayerを開きます。ほかの参加者には、「参加URLをコピー」でコピーしたURLを渡してください。管理用リンクは渡さないでください。
2. ブラウザで聞く人は、Playerの「音声を有効にする」を押します。
3. VTTでキャラとして公開発言すると、Playerの「キャラの声」にそのキャラが表示されます。「声を選ぶ」で声を作り、試聴して「保存」します。
4. 管理画面の「読み上げ開始」を押し、新しく発言して、読み上げられることを確かめます。

読み上げ停止中の発言や、声が未設定のキャラの発言は、あとから読み上げません。チャットによる声登録や長いセリフの分割などは、「5 声と読み上げの調整」で設定できます。

### 別のPCの参加者に音声を届ける場合

`127.0.0.1` のURLは、開いたPC自身を指すので、別のPCでは使えません。[Playerの公開](online.md)に従って、管理画面の「0 起動設定」で待ち受けアドレスと公開Originを設定して再起動し、管理画面から参加URLを取り直してください。

Discordだけで音声を配り、音声担当者が全員のキャラの声を設定するなら、Playerを公開しなくても使えます。

## 7. 終了とデータの保存先

- 「6 終了」の「セッション終了」は、読み上げを止め、参加者とCollectorの接続を閉じます。Bridgeは動いたままです。
- 「Bridgeを終了」か、起動した端末での `Ctrl+C` でBridgeを終了します。内蔵TTSも一緒に止まります。外部TTSは止まらないので、別に終了してください。

|                   | A（`npm start`）                                    | B（実行ファイル）                                                                                                 |
| ----------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 保存先の既定      | `tts-bridge/data/`                                  | macOS：`~/Library/Application Support/TRPG-Voice-Bridge/data/`、Windows：`%LOCALAPPDATA%\TRPG-Voice-Bridge\data\` |
| 保存先の指定      | 管理画面の「0 起動設定」か、環境変数 `TTS_DATA_DIR` | 管理画面の「0 起動設定」か、`--data-dir` か `TTS_DATA_DIR`                                                        |
| 内蔵TTSの設定     | なし                                                | 保存先の `runtime.json`                                                                                           |
| 内蔵TTSの参照音声 | なし                                                | 保存先の `voices/`                                                                                                |

どちらも、設定・キャラ・声の割り当ては保存先の `bridge.sqlite` に、Discordの設定は `discord.json` に保存されます。

バックアップや移行では、Bridgeを終了してから保存先のフォルダ全体をコピーしてください。モデル（GGUF）は保存先に入らないので、別に保管し、移した先で指定し直します。外部TTSの参照音声は、外部TTSの側でバックアップしてください。

`config.json` は、初めて起動したときの初期設定です。保存済みの設定は管理画面で変えてください。Bの実行ファイルは `tts-bridge/config.json` を使わず、ビルド時に作った初期値を使います。

### 卓ごとに保存先を分ける

管理画面の「0 起動設定」で保存先を変えて「保存して再起動」を押すと、その保存先に切り替わります。今の保存先のデータは移動も削除もしません。保存先が空なら、初めて起動したときと同じ状態から始まります。

起動するときに指定する場合は、次のようにします。

```sh
# A（macOSなどのシェル）
TTS_DATA_DIR=./data-table-a npm start
```

```powershell
# A（Windows PowerShell）
$env:TTS_DATA_DIR = '.\data-table-a'
npm start
```

Bでは、起動コマンドの `--data-dir` を卓ごとに変えます。同時に複数のBridgeを動かす場合は、保存先に加えて、Bridgeのポート、内蔵TTSのポート、Collectorの接続先も分けてください。

### 待ち受けや公開先を変える

保存先・待ち受けアドレス・ポート・公開Originは、管理画面の「0 起動設定」で変えて「保存して再起動」で反映できます。Bridgeは同じプロセスのまま再起動し、管理画面も新しいアドレスで開き直されます。「設定初期化」を押すと既定値に戻して再起動します。保存先の中のデータは削除しません。

「0 起動設定」の値は、保存先の外の `startup.json` に保存されます。

| A（`npm start`）          | B（実行ファイル）                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tts-bridge/startup.json` | macOS：`~/Library/Application Support/TRPG-Voice-Bridge/startup.json`、Windows：`%LOCALAPPDATA%\TRPG-Voice-Bridge\startup.json` |

起動するときに環境変数や起動オプションで指定することもできます。指定した項目は「0 起動設定」の値より優先され、「0 起動設定」では変更できなくなります。

| 環境変数            | 既定値                                            | 用途                                                                                       |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `TTS_BRIDGE_HOST`   | `127.0.0.1`                                       | Bridgeの待ち受けアドレス                                                                   |
| `TTS_BRIDGE_PORT`   | `8090`                                            | Bridgeの待ち受けポート                                                                     |
| `TTS_LOCAL_ORIGIN`  | `http://127.0.0.1:待ち受けポート`                 | ローカルの管理画面のOrigin。指定すると「0 起動設定」でポートを変更できない                 |
| `TTS_PUBLIC_ORIGIN` | なし                                              | 参加者向けに公開するOrigin。例：`https://voice.example.com`（パスと末尾の `/` は付けない） |
| `TTS_CONFIG_FILE`   | Aは `tts-bridge/config.json`、Bはビルド時の初期値 | 初期設定のファイル。保存済みの設定は上書きしない                                           |
| `TTS_DATA_DIR`      | 上の表の保存先                                    | 設定・認証・キャラ・声の割り当てなどの保存先                                               |
| `TTS_STARTUP_FILE`  | 上の表の `startup.json`                           | 「0 起動設定」の保存先                                                                     |

Bでは、`--port` と `--data-dir` が環境変数より優先されます。`--tts external` / `--tts bundled`、`--model`、`--tts-port`、Windowsの `--tts-backend vulkan` / `--tts-backend cpu` で、その回の起動だけ設定を変えられます。これらは `runtime.json` の保存値を書き換えません。

HTTPSのリバースプロキシを用意してある場合は、「0 起動設定」の公開OriginにそのHTTPSのURL（例：`https://voice.example.com`）を指定します。同じPCのプロキシから転送するなら、待ち受けアドレスは `127.0.0.1` のままで使えます。環境変数で指定する場合は、次のように起動します。

```sh
# macOSなどのシェル
TTS_PUBLIC_ORIGIN=https://voice.example.com npm start
```

```powershell
# Windows PowerShell
$env:TTS_PUBLIC_ORIGIN = 'https://voice.example.com'
npm start
```

Bでも、同じ環境変数を設定してから起動します。公開のしかたは[Playerの公開](online.md)を見てください。

## 8. 更新とうまくいかない場合

### ソースを更新したとき

Bridgeを終了してから新しいソースに替え、`tts-bridge/` で `npm ci` を実行します。AでDiscordを使う場合は `npm --prefix discord ci` も実行します。

Bで実行ファイルを作り直すときは、`package:speech` → `package:build` → `package:smoke` の順に実行してください。ZIPを展開し直したら、使用しているCollector・Chatterも新しいフォルダから読み込み直します。今までのデータを使う場合は、同じ保存先を指定してください。

AでChatterのソースや共通Playerを更新したら `npm run chatter:build` を再実行してください。バージョンを変更するときは `package.json` を更新して `npm run version` を実行すると、Collector・ChatterのManifestとlockfileも同期します。`npm run version:check` はずれを検出します。

ソースを変えた場合は、`npm test` と `npm run test:browser` で確かめられます。`test:browser` を初めて実行する前に `npx playwright install chromium` を実行してください。書式は `npm run format:check` で確認し、`npm run format` で整えられます。プルリクエストとmainへのpushでは、GitHub Actionsの「Tests」がこの3つを実行します。

作成したZIPと同梱拡張をブラウザで検証する場合は、`npm run package:smoke:browser` を実行します。実行ファイルはNodeやnpmがPATHにない状態で起動し、配布版PlayerとChatterの双方向チャットを確認します。

### よくある問題

| 症状                                          | 確かめること                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Build with Node.js ...`                      | `node --version` が `packaging/node-version` と同じか。Node.jsを切り替えたあとに `npm ci` をやり直したか                              |
| `build.json` がない、`Run package:speech ...` | `npm run package:speech` が最後まで終わったか。今のOSと `speech-lock.json` に合ったビルドか                                           |
| WindowsでVulkan SDKやClangCLが見つからない    | SDK、Visual StudioのC++ビルド環境とClangCL、`VULKAN_SDK` と `PATH` の設定                                                             |
| Node.jsの `LICENSE` が見つからない            | nodejs.orgの公式配布物のNode.jsを使っているか                                                                                         |
| `npm start` に「TTSの起動設定」がない         | 内蔵TTSはBの実行ファイルで使う（1節）                                                                                                 |
| TTSが「未接続・準備中」                       | 外部TTSが起動しているか、接続先のURLとポート。内蔵TTSならモデルの読み込みが終わったか                                                 |
| 内蔵TTSが「起動失敗」                         | GGUFの絶対パスとファイルの有無、空きメモリ、ポートの重複、WindowsのGPUドライバー。必要ならCPU版にして保存し、「Bridgeを再起動」を押す |
| 設定を保存しても変わらない                    | 「次回起動の設定を保存」は再起動で反映される。表示される「Bridgeを再起動」を押す                                                      |
| Bridgeが起動しない                            | 8090の重複、保存先へのアクセス権。Bでは `runtime/` の配置と、同じ保存先での二重起動                                                   |
| Collectorが接続できない                       | 拡張の「Bridge接続先」、VTTへの入室、初回の承認のあとに接続し直したか                                                                 |
| 接続済みなのに音声が出ない                    | 読み上げ開始、キャラの声の保存、「このキャラを読み上げる」、Playerの音声の有効化、またはDiscordの接続先                               |
| 別のPCで参加URLを開けない                     | `127.0.0.1` のURLを渡していないか。Playerの公開の手順（待ち受けアドレスと公開Origin）                                                 |

管理画面に「音声生成の確認が必要です」が出た場合は、TTSの処理が終わったことを確かめてから「Irodori側の処理終了を確認して復帰」を押してください。

macOSの実行ファイルはアドホック署名で、Appleの公証は受けていません。Windowsの実行ファイルにはコード署名がありません。OSが起動を止める場合は、作ったパッケージの `README.txt` を見てください。

## 関連資料

- [セットアップガイド](setup-guide.md)：構成図、Collector、VTTごとの取得の条件。
- [Bridgeの詳細](../tts-bridge/README.md)：設定・操作・保存の仕様。
- [Discordでの利用方法](discord.md)：Botの作成・招待・権限。
- [Playerの公開](online.md)：別のPCの参加者にPlayerを公開する方法。
- [パッケージのビルド処理](../tts-bridge/packaging/build.mjs)、[speech.cppのビルド処理](../tts-bridge/packaging/build-speech.mjs)：この手順で動く処理。
