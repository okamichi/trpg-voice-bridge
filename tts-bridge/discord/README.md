# Discord Bot

## 管理画面から使う

Botの作り方と管理画面での設定は、[Discordでの利用方法](../../docs/discord.md)を見てください。

ソースから `npm start` で起動する場合は、初回だけ `tts-bridge/` でDiscord用の依存を入れます。

```sh
npm --prefix discord ci
```

Discordで聞く参加者は、Playerの音声を有効にしないでください。すでに再生中の場合は、Player上部の「音声を停止」を押してください。
「音声を再開する」を押すと、新しい発言から再生します。停止中のセリフをまとめて流すことはありません。
Playerはログと声の設定に引き続き使えます。Discordに入っていない人は、今までどおりPlayerで再生できます。
Playerのキャラ別ミュートはBotには反映されません。Botの音量は各自のDiscordで調整します。

## 保存と終了

- 設定はBridgeの保存先の `discord.json`（権限0600、Git対象外）に保存します。保存先の既定は `tts-bridge/data/` で、`TTS_DATA_DIR` で変えられます。
- トークンは画面・状態API・ログに返しません。「トークンを削除」でログアウトし、保存したトークンを消します。
- 「接続」の後は次回起動時に自動接続します。「切断」の後はログインだけです。「Discord Botに接続する」がオフなら、ライブラリも読み込みません。
- 入退室音声は本文・声・TTS接続先・演技指定方式に応じて生成し、キャッシュします。
  入室は生成と再生を合わせて最長15秒。退出はキャッシュ済みの音声だけを最長15秒流します。
- Ctrl+C / SIGTERMでは退出音声を流して終了します。強制終了・接続障害では流せません。
- 切断中のセリフは捨て、再接続時は最新位置から読み上げます。短い通信断では同じ音声リソースを維持します。
- 音声生成の不調で入退室メッセージを生成できなくても、接続処理は続行します。

## 単体の実機確認（try-play.mjs）

常駐Bridgeとは別の診断用スクリプトです。同じBotで常駐接続している間は実行しないでください。

```sh
cd tts-bridge/discord
npm ci
node try-play.mjs --check
cd ..
```

シェルで、トークンを履歴・画面に残さず入力します。

```sh
read -s 'DISCORD_BOT_TOKEN?Bot token: '; echo
export DISCORD_BOT_TOKEN
node discord/try-play.mjs
```

Bot名、招待URL、`サーバー名 / チャンネル名: ID` が表示されます。
まだ招待していなければURLを開き、対象のサーバーを選んで招待してから再実行してください。
特権intentは不要です。Botにはチャンネルの表示・接続・発言を許可してください。

ご自身もDiscordで対象のボイスチャンネルに入り、表示されたIDとWAVを指定します。
WAVは120秒以内、モノラルまたはステレオ、16/24/32bit PCMまたは32/64bit floatです。

```sh
node discord/try-play.mjs チャンネルID target.wav
unset DISCORD_BOT_TOKEN
```

一覧表示だけなら入室しません。IDとWAVを指定すると、Readyを待ち、1本再生して退出します。
Ctrl+Cでも退出します。トークンは保存しません。
`--check` はトークンなしでDAVEのロード、Opusエンコード、AES-256-GCMを確認します。
FFmpegは使いません。

うまくいったかの見方:

- `Voice: ready` になり、close code 4017が出ない。
- Discordで音声が聞こえ、終了後にBotが退出する。
- Bot名、サーバー名、権限のないチャンネルの表示が正しい。

「送信完了」は音声を実際に聞けたことを保証しません。Discord側で実際に聴いて確認してください。

参考: [公式Voice接続ガイド](https://discordjs.guide/voice/voice-connections)。
