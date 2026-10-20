# Chatter

D&D Beyond Mapsなどを表示した隣のChromeサイドパネルで、キャラの発言・声設定・音声再生を使います。Collectorのインストール、入力元登録、VTTへのスクリプト注入は不要ですが、参加者全員が Chatter をインストールする必要があります。

## 読み込みと参加

1. **配布ZIPの場合**は、展開した `TRPG-Voice-Bridge/chatter/` を使います。必要な画面・コードは同梱済みで、Node.jsやビルドは不要です。**ソースから使う場合**は、`tts-bridge/` で `npm run chatter:build` を実行し、`tts-bridge/chatter/` を使います。
2. Chromeの `chrome://extensions` でデベロッパーモードを有効にし、「パッケージ化されていない拡張機能を読み込む」から、この `chatter/` フォルダーを選びます。
3. VTTを開き、Chatterの拡張アイコンを押してサイドパネルを開きます。
4. BridgeのURL（例 `http://127.0.0.1:8090`）と、管理者から受け取った招待リンクを入力します。接続先へのアクセスを許可して参加します。招待リンクの接続先とBridgeのURLは一致させてください。
5. キャラを作成・選択して送信します。「キャラ・声設定」で声を設定できます。音声を聞くときだけ「音声を有効にする」を押します。

画面のソースを変更したら、再度 `npm run chatter:build` を実行し、Chromeの拡張を再読み込みしてください。生成ファイルは直接編集しません。`npm run package:build` は配布用Chatterをソースから生成し、ZIPへ同梱します。Bridge・Collector・Chatterは同じバージョンを使い、`npm run version` で同期、`npm run version:check` で検査できます。配布ZIPを更新した場合は、新しい `chatter/` をChromeで読み込み直し、招待で再参加してください。

## 共有と履歴

発言は接続したBridgeの卓に参加するPlayer・Chatterへ共有されます。チャット本文はBridgeのDBへ直近7日・卓ごとに最大10,000件保存され、再参加した人も閲覧できます。共有対象のCollector発言も同じ履歴に入ります。声を設定し、管理者が読み上げを開始すると、利用者のブラウザや接続済みDiscordにも音声を配信します。秘話機能はありません。

- 「チャットと本文の共有」をOFFにすると、参加者の送信・本文閲覧を止めます。保存済み履歴を消す操作ではありません。
- 「卓のチャット履歴を消去」は卓全体の本文を消し、接続中画面にも反映します。音声配信は別に停止してください。
- 「読み上げ停止」や「セッション終了」だけでは本文は消えません。「もう一度再生」は音声が残っているときに、押した本人の画面だけで再生します。

## 閉じる・退出する

- パネルを閉じると通信と再生が止まります。再度開くと同じ参加資格で履歴を復元し、音声は停止状態から始まります。閉じていた間の音声は自動再生しません。
- 「退出・接続先を変更」は参加資格をサーバーで失効させます。接続画面へ戻って、別の接続先と招待を入力できます。通信障害で退出を確認できなかった場合は、接続復旧後に「退出を再試行」を押します。
- 参加資格はブラウザのセッション内だけに保持します。ブラウザ終了、拡張再読み込み、Bridge再起動、セッション終了、参加資格の期限切れ（12時間）後は再参加が必要です。
- Web PlayerとChatterの両方で音声を有効にすると、二重に聞こえます。Discordを含め、聞く場所を一つ選んでください。

## 認証と権限

参加者トークンは `chrome.storage.session` に保存し、永続ストレージ・URL・ログへ書きません。招待リンクも保存しません。接続先URLは `chrome.storage.local`、下書きとキャラ選択は接続先・卓別のローカルストレージに保存します。

HTTPはBearerトークン、WebSocketは最初の `hello` メッセージで認証します。トークンは卓・セッション・有効期限・拡張Origin・接続先Hostに紐付き、管理者やCollectorの権限を持ちません。拡張fetchでOriginが省略される場合は明示的な `X-Chatter-Origin` を使います。Originがある場合は一致が必要で、通常のWebサイトへのCORS許可は追加していません。接続先からのHTTPリダイレクトも追いません。

権限要求は選んだ接続先のスキームとホストに限定します。Chromeのホスト権限はポートを区別しないため、通信コードでも選択したポートを含むURLに制限しています。実装はChromeの[サイドパネルAPI](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)と[拡張のクロスオリジン通信](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)に従います。

## 検証

`npm test` でトークンの分離・失効・WebSocket認証待機の上限を確認します。`npx playwright test e2e/chatter.spec.mjs` で実際のChromium拡張、Chromeのサイドパネル、Playerとの会話、試聴・音声再生、パネル開閉、退出・接続先変更、ブラウザ再起動を確認します。TTSはモック、VTTはテスト用ページを使います。

`npm run package:smoke:browser` は作成したZIPを展開し、配布版Bridgeと同梱Chatter・Playerで参加、双方向チャット、履歴復元、退出を検証します。事前に `npx playwright install chromium` が必要です。

ヘッドレスChromeではネイティブの権限確認ダイアログを操作できないため、テスト用コピーに選択先だけ事前許可します。製品Manifestに常時許可はありません。権限拒否時の画面は別途検証します。実際の許可ダイアログの操作と、ログイン済みD&D Beyond Mapsとの並列表示は手動確認が残ります。
