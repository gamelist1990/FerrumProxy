# FerrumProxyでNetherNetを中継する

`bedrockTransport: nethernet` をリスナーに指定すると、TCPは従来の転送を使い、UDPをWebRTC用の透過データグラム転送に切り替える。
`haproxy: true` は、このモードではTCP signalingだけに適用される。
UDPにPROXYヘッダーを付加・除去せず、RakNetのPongキャッシュ・ポート書き換え・再接続判定も行わない。
クライアントごとに同じupstream UDPソケットを保持し、WebRTCの無通信時の待機時間は最低60秒とする。
指定しないリスナーは従来のRakNet動作を継続する。

## 外部FerrumProxy → PEXServer上のGeyser

1. `config.nethernet.example.yml` をコピーし、`target.host` をPEXServerの到達可能なIPへ置き換える。
2. 外部ProxyとPEXServerのネットワークで TCP 5000 と UDP 5000 の両方を通す。
3. Geyserの生成済み設定へ `docs/geyser-nethernet.example.yml` の設定を反映する。Javaサーバーのアドレスと認証方式は現在の設定を使う。
4. `haproxy-protocol-whitelisted-ips` に、PEXServerから見えるFerrumProxyの送信元IPを設定する。
5. Geyserを次のように起動する。公開IPは、Bedrockクライアントが接続する外部FerrumProxyのIPv4アドレス。

```powershell
java --enable-native-access=ALL-UNNAMED -DgeyserAdvertiseAddresses=PROXY_PUBLIC_IPV4 -jar Geyser-Standalone.jar --nogui
```

6. 外部Proxy側で改修後のバイナリを起動する。

```powershell
ferrum-proxy --config config.nethernet.example.yml
```

Bedrockから外部Proxyの公開アドレス・ポート5000へ接続する。
使用するクライアントはNetherNetのHTTP signalingに対応している必要がある。
公開するUDPポートとGeyserのWebRTC UDPポートを5000にそろえる。
TCP signalingを中継するだけでは、ICEがバックエンドの直接アドレスへ向かう可能性があるため、公開アドレスの指定も必要。
FerrumProxy自身はSDP/ICE候補を書き換えない。
Geyserの `bedrock.address` は `0.0.0.0` または到達可能なローカルアドレスを使い、loopbackを実運用のWebRTC bindに使わない。

GUIではリスナー設定の「NetherNet / WebRTC を使用」を有効にし、TCPとUDPの両方と転送先を設定できる。
RakNetと併用する場合は、別のUDPポート・別リスナーを使い、Geyserの `transport: both` と `webrtc-port` をそれぞれ合わせる。

この対応は静的な `listeners` の直接転送に適用する。
`sharedService` / FerrumClientの動的トンネルには新モードを追加していない。
それらのトンネルで `--haproxy` を指定すると従来どおりUDPにもヘッダーを付加するため、この設定をそのまま適用しない。

## 検証結果

### Paperとbuiltin signalingのTCPポート競合

`Built-in signaling cannot use port 5000 because the Java server already uses it` と出る場合、
TCP 5000はPaperのJavaリスナーが使用しており、GeyserのHTTP signalingではない。
UDPは同じ番号を使用できても、同じアドレスのTCPリスナーを共有することはできない。
このログが出た起動では、Geyserは外部signalingへフォールバックする。

Paper TCP 5000をそのまま使い、Bedrock公開ポートを19132にする構成例:

| 用途 | FerrumProxy公開ポート | 転送先 |
|---|---|---|
| Java | TCP 25565 | `100.83.127.8:5000` TCP |
| NetherNet signaling | TCP 19132 | `100.83.127.8:19132` TCP |
| NetherNet WebRTC | UDP 19132 | `100.83.127.8:19132` UDP |

`config.pexserver-nethernet.example.json` にこの例を保存している。
Geyser側は `bedrock.port: 19132`, `bedrock.webrtc-port: 0`,
`bedrock.transport: nethernet`, `bedrock.signaling.mode: builtin` を指定する。
`-DgeyserSignalingPort` に5000を指定している場合は外すか19132へ変更する。
Geyser-Spigotを使う場合、`-DgeyserAdvertiseAddresses=<Proxy公開IPv4>` はPaperを起動するJavaコマンドの `-jar` より前に指定する。

起動ログで `Built-in signaling started` とポート19132を確認し、公開側とバックエンド側のTCP/UDP 19132の開放を確認する。
HTTPの場合、`curl --max-time 5 http://play.pexserver.com:19132/v1/join` でHTTP 200の応答を確認してからBedrock接続を試す。
HTTP 200だけではUDP到達性やゲームログインの成功は証明できない。

2026-10-05、PR #6712 standalone preview build 3056 (`bc81f9e`) で確認。

- FerrumProxyのTCP転送 → PROXY v2 → スタンドアロンGeyser builtin signaling の `GET /v1/join` が HTTP 200 を返した。
- 同じ配布JAR内のネイティブWebRTC実装を使い、FerrumProxyのUDP中継経由でSCTP DataChannelを確立し、メッセージの往復を確認した。
  このテストでは直接接続するICE候補を除き、テスト用にanswerのUDP候補をローカルProxyへ向けた。
  実際に選択された接続先のポートがProxyのポートであることも検証した。
  12秒間アプリケーションデータを送らず待機した後も同じDataChannelで往復できた。
- UDPのバイト列保持、Pongキャッシュの回避、クライアントごとのソケット分離、既存RakNetの初回PROXY送信をRustのソケットテストで確認した。
- GUIフロントエンドのビルドを確認した。

ネイティブUDP経路の再確認用ソース: `docs/probes/WebRtcRelayProbe.java`。
NetherNetモードのFerrumProxyをUDPポートPUBLIC_PORTからBACKEND_PORTへ起動したうえで、同じマシンの到達可能なIPv4と各空きポートを指定する。

```powershell
java --enable-native-access=ALL-UNNAMED -cp Geyser-Standalone.jar C:\path\to\WebRtcRelayProbe.java LOCAL_IPV4 BACKEND_PORT CLIENT_PORT PUBLIC_PORT
```

これらはローカルのsignaling経路・WebRTC UDP経路の検証であり、実Bedrockクライアントによるログイン・ワールド参加や外部PEXServerでの動作を実測したものではない。
プレイヤー実IP保持を追加する修正は、この変更には含めていない。
追加調査ではTCP signaling由来のIPがGeyserのpeer APIに残る動作を確認したが、実Bedrockログイン後の確認は未実施。
詳細は `docs/nethernet-pr6712-check.md`。
