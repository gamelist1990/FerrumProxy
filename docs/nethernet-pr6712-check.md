# NetherNet / PROXY protocol 確認結果

確認日: 2026-10-05 (Asia/Tokyo)

この文書のFerrumProxy側の評価はNetherNetモード追加前のもの。後続の改修と接続手順は [nethernet-setup.md](nethernet-setup.md) を参照。

## 結論

PR #6712 の preview build 3056 は NetherNet と builtin HTTP signaling を実装している。
`advanced.bedrock.use-haproxy-protocol: true` は **TCP signaling の PROXY v1/v2 受信にも適用される**。
したがって「NetherNet は PROXY protocol を全く受け取れない」は、このビルドには当てはまらない。

ただし **TCP と UDP の両方を通常のリバースプロキシ経由にして、Geyser のプレイヤーIPまで保持する要件は、現状の構成では満たせない**。
配布JARの WebRTC 接続成立処理は、signaling から取得したアドレスを実際の WebRTC UDP 接続先で上書きする。
UDP の送信元を中継サーバーのアドレスへ変更する方式では、プレイヤーのアドレスがその中継先になると実装から判断できる。
これはソース・配布JARの解析に基づく判断であり、実Bedrockクライアントによるログイン実測ではない。

## 対象の固定

- PR: https://github.com/GeyserMC/Geyser/pull/6712
- ダウンロード: https://download.geysermc.org/v2/projects/geyserpreview/versions/pr.6712/builds/latest/downloads/standalone
- バージョン: `2.12.0-SNAPSHOT (git-DEV-bc81f9e)`
- build number: `3056`
- JAR内 `git.properties` のcommit: `bc81f9ed819e946a83121c9a8d26600407027cc4`
- SHA-256: `9eec54298a70c7702936887bf79289c12d077a91dacd9c1310cf607d00124223`
- 実行環境: Windows / Eclipse Adoptium JDK 25.0.2

`latest` の取得結果を上記で固定して確認した。今後のビルドについては再確認が必要。

## 実行した確認

スタンドアロンGeyserを隔離した一時ディレクトリで起動した。
`transport: nethernet`, `signaling.mode: builtin`, TCP port 25000,
Bedrock側PROXY protocol有効、信頼するプロキシ `127.0.0.1` で
`Built-in signaling started` を確認した。
PROXY v1 の直後に `GET /v1/join` を送信すると `HTTP/1.1 200 OK` を返した。
loopback はHTTPリスナー検証用であり、実際のWebRTC接続用としては使えない。

さらに配布JARに含まれる `NetherNetHTTPSignaling` を直接使用する検証ハーネスで、
MOTD callback に渡されたアドレスを観測した。
`docs/probes/ProxyProbe.java` に再実行可能なソースを保存した。

| ケース | 観測したIP | 結果 |
|---|---|---|
| 信頼する送信元から TCP PROXY v1 | `203.0.113.42:45678` | PASS / HTTP 200 |
| 信頼する送信元から TCP PROXY v2 | `203.0.113.42:45678` | PASS / HTTP 200 |
| PROXY 有効でヘッダーなしHTTP | `127.0.0.1` | PASS / HTTP 200 |
| 信頼する送信元から X-Forwarded-For | `203.0.113.43` | PASS / HTTP 200 |
| 信頼対象外から X-Forwarded-For | `127.0.0.1` (転送IPを無視) | PASS / HTTP 200 |

ここで使用した `203.0.113.x` はテスト値で、外部の実クライアントを接続した結果ではない。
HAProxy本体、外部Proxyサーバー、PEXServerへの接続、実Bedrockログイン、Java側IPの観測は実施していない。
検証プロセスは終了済み。既存の運用設定は変更していない。

再実行例 (対象JARを用意して、その保存ディレクトリで実行):

```powershell
java --enable-native-access=ALL-UNNAMED -cp .\Geyser-Standalone.jar C:\path\to\ProxyProbe.java
```

## IPが上書きされる箇所

Geyser `NetherNetServer.startInbuilt()` は次の設定を signaling builder に渡す。

```java
.setTrustedProxies(TrustedProxies.parse(config.advanced().bedrock().haproxyProtocolWhitelistedIps()))
.setProxyProtocol(config.advanced().bedrock().useHaproxyProtocol())
```

配布JARを `javap -c -p` で確認した結果:

1. `NetherNetHTTPSignaling$SignalingHandler.clientAddress()` は信頼するTCP送信元を確認し、PROXY由来アドレス、次に X-Forwarded-For を採用する。
2. signaling のアドレスが `NetherNetServerChannel.acceptConnection()` に渡り、子チャンネルの初期アドレスになる。
3. `NetherNetServerChannel$ServerPeerConnectionObserver.onConnectionChange()` の `RTC_CONNECTED` 分岐は次の処理を行う。

```java
InetSocketAddress raw = peerConnection.remoteAddress();
child.setRemoteAddress(new InetSocketAddress(raw.getHostString(), raw.getPort()));
```

4. `BedrockPeer.getSocketAddress()` は `channel.remoteAddress()` を返す。signalingで取得した元IPを別途返す処理は、この経路にはない。

参考ソース:

- Geyser: https://github.com/GeyserMC/Geyser/blob/bc81f9ed819e946a83121c9a8d26600407027cc4/core/src/main/java/org/geysermc/geyser/network/bedrock/nethernet/NetherNetServer.java#L234
- Cloudburst Network: https://github.com/CloudburstMC/Network/blob/17712151d9bfdb88835dba01d489cc9238c452db/transport-nethernet/src/main/java/org/cloudburstmc/netty/channel/nethernet/NetherNetServerChannel.java#L399

Cloudburst のリンクは調査時のブランチHEADで、配布JAR内の依存ビルドのcommitと同一とは断定していない。
上書き処理は配布JARそのものでも確認した。

## FerrumProxy側の評価

- `src/tcp.rs` は `haproxy: true` のとき TCP PROXY v2 を送る。上記signalingとのプロトコル上の互換性がある。
- `src/udp.rs` は `haproxy: true` のとき初回UDPデータグラムに PROXY v2 を付加する。これはCloudburst RakNetのマッピングを前提とした処理。
- NetherNet のWebRTC UDPは、このRakNet用ヘッダーを受け取る経路ではない。WebRTC側へ付けると正常なSTUN/DTLSデータグラムではなくなる。
- 同じlistener ruleの `haproxy` はTCPとUDPの両方に効くため、NetherNetを中継するならTCP用ruleとUDP用ruleを分ける等の対応が必要。
- UDPのPROXY付加を無効にしても、通常のUDP中継はバックエンドから見える送信元を変更するため、プレイヤー実IP保持は解決しない。
- このリポジトリにはNetherNet signaling/SDPの解釈、ICE candidateの書き換え、WebRTCの終端処理はない。単純なTCP/UDP転送が接続成立するかは、広告アドレスとICE経路を含む追加検証が必要。

## 運用上の判断

実IP保持が必須なら、現時点で既存RakNet構成からの移行を確定しない。
Geyser側の `use-haproxy-protocol: true` は builtin TCP signaling に意味があるため、単純にfalseへ切り替えることも解決にならない。

要件を満たす候補は、signalingで得た信頼済み元IPをGeyserの論理プレイヤーIPとして保持する上流修正、
またはUDPの実送信元を保つ透過転送/ルーティング構成。
どちらも実Bedrockログイン後に Geyser と必要ならJava側でIPを観測して確定する必要がある。
`-DgeyserAdvertiseAddresses` による公開ICEアドレス指定は到達経路の設定であり、実IPの保持処理を置き換えるものではない。
