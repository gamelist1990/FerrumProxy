# NetherNet解析ログとGUI

インスタンスの「概要 / ログ / 設定 / プレイヤーIP」に続く **NetherNet** タブで解析します。

## 有効化

1. 新しいRust本体とGUIを両方更新します。
2. 設定 → NetherNetリスナー → **NetherNet解析ログ** をONにし、保存して本体を再起動します。
3. まず公開IP・公開UDPポートの補正欄を空欄のまま、接続を試します。
4. NetherNetタブでIPを検索し、時系列を開いてください。

JSONの場合、リスナーに `"nethernetDiagnostics": true` を追加します。`bedrockTransport` は `nethernet` にしてください。一般の `debug` はfalseでも解析イベントをINFOレベルで記録します。大量の汎用UDPデバッグログを減らしたい場合はdebugをfalseにできます。

`config.pexserver-nethernet-diagnostics.example.json` は公開TCP/UDP 19132からGeyser TCP/UDP 19132へ転送する、補正なしの解析用サンプルです。実際の待受ポートに合わせてください。

## 記録内容

- クライアントとbackendのTCPエンドポイント、公開候補の補正設定。
- GET/POSTの順序、HTTPステータス、offer/answerのcandidate IP・ポート・種別。
- 補正ありの場合はSDP候補の補正前後。
- RakNet ping / OpenConnectionRequest1、STUN binding request/response/error、DTLS、未判別UDP。
- UDPの方向、Proxy側ソケット、アイドル終了時の送信・返信パケット数。
- TCP中継エラー、補正エラー、一部のHTTP解析スキップ。

UDPは毎パケットではなく、同じUDPセッション内の方向・種別の初回を記録します。サイズだけでプロトコルを推測せず、RakNet magic、STUN cookie、DTLSレコードヘッダーで判別します。HTTPを分割受信した場合は再構成し、Content-Length・chunked・接続終了による区切りに対応します。

## 観測の範囲

補正なしのHTTP解析は読み取ったバイトをそのまま転送します。解析の上限超過・未知形式・圧縮などでは解析を省略し、接続自体を解析理由で切断しません。補正を有効にした場合の既存のSDP書き換え処理とは独立しています。

STUNやDTLSを見てもゲーム参加成功とは表示しません。RakNet要求とTCPの終了が同じIPで続いていても、フォールバックとは断定しません。同一IPの複数端末・接続試行は同じグループに表示され、各イベントに元のTCP/UDPポートを残します。

GUIは保持中のログから解析するため、ログが破棄された区間には言及できません。「返信未観測」は保持ログ内での観測です。ログは再起動でリセットされ、上限1000件です。解析JSONの保存で共有できます。旧本体の通常UDPデバッグログだけでは本文がないためプロトコル判別できません。

SDP本文全体、identityトークン、ICE password、fingerprintの値、Authorizationヘッダー、任意のURLクエリ、JSONのnonceは解析ログ・解析JSONに出しません。IPとポートは解析対象として含まれます。

公開側TLSをFerrumProxyで終端する場合は解析対象です。GeyserまでTLSをそのまま通す場合は暗号化された本文を解析できません。

稼働サーバーへの配布・再起動と、実プレイヤーによるゲーム参加はこの作業では行っていません。

## 解析ONで初期接続が止まる問題の修正

旧解析ビルドには、解析を有効にするとTCP転送前にCRLF形式のHTTPヘッダー終端を待つ処理がありました。TLSなどの初期データ、LF形式のHTTPで転送が止まる不具合をローカルで再現しています。修正版では解析のみの場合にその待ちを行わず、TCPの初期データからそのまま転送します。LF形式のHTTPも解析し、TLSレコードは `inspection_skipped / tls_encrypted` として本文の解析を省略します。送受信の半閉鎖処理も通常の透過転送に合わせています。

補正を有効にした場合でも、HTTPと判別できない初期データをHTTPヘッダーとして待ちません。これは観測処理の修正で、実サーバーでの接続成功は更新後の再確認が必要です。修正前に失敗、修正後に成功するTCP統合テストを追加しています。

本体のみの更新で適用されます。既存のNetherNetタブ付きGUIはそのまま使用できます。
