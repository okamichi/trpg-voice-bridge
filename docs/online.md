# オンライン公開の準備

公開先ドメイン・トンネル・別ネットワークの試験端末は未指定のため、今回は公開していません。以下は構成例です。

以下は**bridgeとIrodoriを音声担当者（GMまたはPL）のPCで動かし、参加者向けPlayerを公開する例**です。VTTを自宅、bridgeを別宅に置く場合の通信と未実装部分は[セットアップガイド](setup-guide.md#vttは自宅bridgeは別宅に置く場合)に記載しています。

1. Irodoriとbridgeは音声担当者（GMまたはPL）のPCで起動します。
2. HTTPS/WSSを終端できる入口を用意します。Caddyを同じPCで動かす場合は[Caddyfile.example](Caddyfile.example)のホスト名を実際のものへ変更し、ドメイン、証明書発行、443番への到達性を環境に合わせて用意します。
3. `TTS_PUBLIC_ORIGIN=https://voice.example.com npm start`でbridgeを起動します。Originには末尾スラッシュやパスを含めません。
4. 管理画面は引き続き`http://127.0.0.1:8090/admin/`で開きます。「参加URLを発行」のリンクがHTTPSになったことを確認します。
5. 別ネットワークから参加URLを開き、音声を有効にして確認します。

Caddyの`reverse_proxy`はWebSocketのUpgradeにも対応します。`handle`でPlayerに必要なパスだけを転送する設定です。Hostヘッダーをローカルの値へ書き換えず公開ホストを維持してください。[公式reverse_proxy資料](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)、[handle資料](https://caddyserver.com/docs/caddyfile/directives/handle)。

転送対象は`/player/*`、Player用JS/CSS、`/api/v1/join`、`/api/v1/rooms/*`、`/ws`です。`/admin/`、`/api/v1/admin/*`、`/api/v1/events`、`/api/v1/collectors/*`、Irodoriの8088番は対象外です。全パスをそのまま公開するトンネル設定はこの構成例には含めていません。

招待はURLフラグメントからPOSTで交換し、その後URLから削除します。公開HTTPSホストでは閲覧cookieにSecureを付けます。APIキー、招待、cookieをアクセスログの本文やクエリへ追加しないでください。

## 実機確認

- 外部URLから管理画面・管理API・Collector入力を開けない。
- Player cookieで生成・設定変更・別卓音声を取得できない。
- 再発行した招待で参加でき、古い招待は使えない。
- セッション終了直後に再生が停止し、音声取得・再接続が拒否される。
- 3台以上の端末で発言順・ミュート・再生中の停止を確認する。
- 10秒以内のネットワーク切断と長い切断で、古い発言の一括再生が起きない。
- 60分の模擬卓で保管容量、生成待ち、端末遅延、帯域を記録する。

HTTP/WSの認証試験はローカルで実施していますが、TLS終端と別ネットワークでの60分試験は未実施です。
