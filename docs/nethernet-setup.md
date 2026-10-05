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
プレイヤー実IP保持は、この変更の対象外。詳細は `docs/nethernet-pr6712-check.md`。
