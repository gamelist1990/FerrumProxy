# NetherNet / PROXY protocol 確認結果

確認日: 2026-10-05 (Asia/Tokyo)

この文書のFerrumProxy側の評価はNetherNetモード追加前のもの。後続の改修と接続手順は [nethernet-setup.md](nethernet-setup.md) を参照。
追加調査でNettyのアドレスキャッシュを確認したため、当初の「UDP中継後に元IPを保持できない」という結論を訂正した。

## 結論

PR #6712 の preview build 3056 は NetherNet と builtin HTTP signaling を実装している。
`advanced.bedrock.use-haproxy-protocol: true` は **TCP signaling の PROXY v1/v2 受信にも適用される**。
したがって「NetherNet は PROXY protocol を全く受け取れない」は、このビルドには当てはまらない。

追加調査では **signaling由来の元IPを、WebRTC接続成立後もGeyserのpeer APIが返す動作を確認できた**。
WebRTC内部のアドレスを更新する処理は存在するが、Nettyの公開 `channel.remoteAddress()` は最初に読んだアドレスをキャッシュする。
Geyserの `preInitChannel()` が初期アドレスを読み、WebRTC側の更新処理はこのキャッシュを無効化しない。
したがって、このビルドで「UDP中継だから元IPは必ず失われる」とは言えない。

配布JAR内の実NetherNetServerChannel・ネイティブWebRTC・Geyser NetherNetPeerを使う検証で、元IPの保持を観測した。
signalingの元IPはテスト値を直接渡し、Geyserと同じ初期化時のアドレス読み出しを行った。
これは実Bedrockログインやワールド参加の実測ではない。また、元IPを明示的に固定する機能ではなくアドレスキャッシュによる動作なので、更新ビルド・初期化順序の変更では再確認が必要。

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

## 内部アドレスの更新と公開APIのキャッシュ

Geyser `NetherNetServer.startInbuilt()` は次の設定を signaling builder に渡す。

```java
.setTrustedProxies(TrustedProxies.parse(config.advanced().bedrock().haproxyProtocolWhitelistedIps()))
.setProxyProtocol(config.advanced().bedrock().useHaproxyProtocol())
```

配布JARを `javap -c -p` で確認した結果:

1. `NetherNetHTTPSignaling$SignalingHandler.clientAddress()` は信頼するTCP送信元を確認し、PROXY由来アドレス、次に X-Forwarded-For を採用する。
2. signaling のアドレスが `NetherNetServerChannel.acceptConnection()` に渡り、子チャンネルの初期アドレスになる。
3. Geyser `NetherNetChannelInitialiser.preInitChannel()` は `channel.remoteAddress()` を読み、接続を許可するか確認する。Netty `AbstractChannel.remoteAddress()` はこの時点のアドレスをキャッシュする。
4. `NetherNetServerChannel$ServerPeerConnectionObserver.onConnectionChange()` の `RTC_CONNECTED` 分岐は次の処理を行う。

```java
InetSocketAddress raw = peerConnection.remoteAddress();
child.setRemoteAddress(new InetSocketAddress(raw.getHostString(), raw.getPort()));
```

5. `NetherNetChannel.setRemoteAddress()` は内部のフィールドを更新するだけで、Netty側のキャッシュを無効化しない。
6. `BedrockPeer.getSocketAddress()` は公開 `channel.remoteAddress()` を返すため、初期IPが返り続ける。
7. `GeyserBedrockPeer.getRealAddress()` は明示的な `proxiedAddress` があればそれを、なければ上記のアドレスを返す。
8. `UpstreamSession.getAddress()` → `GeyserSession.getSocketAddress()` とこのアドレスが引き継がれる。

`docs/probes/LiveAddressProbe.java` の実行結果 (配布JARに含まれる実WebRTC接続を成立させた):

```text
Child init address: /203.0.113.42:45678
Native WebRTC connected; raw UDP peer: /192.168.1.5:60190
Netty channel.remoteAddress: /203.0.113.42:45678
Geyser peer.getRealAddress: /203.0.113.42:45678
PASS original signaling address survives an actual WebRTC connection
```

`203.0.113.42` はsignaling元IPとして直接渡したテスト値。初期化handlerはGeyserのアドレス読み出しを再現する。
Geyser本体の起動・Bedrock認証・ゲームログインを行うテストではない。
実装全体を通した外部クライアントのIP実測と混同しない。

```powershell
java --enable-native-access=ALL-UNNAMED -cp Geyser-Standalone.jar C:\path\to\LiveAddressProbe.java LOCAL_IPV4
```

`LOCAL_IPV4` は検証マシンに割り当てられた到達可能なIPv4アドレス。

参考ソース:

- Geyser: https://github.com/GeyserMC/Geyser/blob/bc81f9ed819e946a83121c9a8d26600407027cc4/core/src/main/java/org/geysermc/geyser/network/bedrock/nethernet/NetherNetServer.java#L234
- Cloudburst Network: https://github.com/CloudburstMC/Network/blob/17712151d9bfdb88835dba01d489cc9238c452db/transport-nethernet/src/main/java/org/cloudburstmc/netty/channel/nethernet/NetherNetServerChannel.java#L399
- Geyser初期化: https://github.com/GeyserMC/Geyser/blob/bc81f9ed819e946a83121c9a8d26600407027cc4/core/src/main/java/org/geysermc/geyser/network/bedrock/nethernet/NetherNetChannelInitialiser.java#L65
- Nettyキャッシュ: https://github.com/netty/netty/blob/4.2/transport/src/main/java/io/netty/channel/AbstractChannel.java#L178

Cloudburst のリンクは調査時のブランチHEADで、配布JAR内の依存ビルドのcommitと同一とは断定していない。
内部更新と公開APIのキャッシュは配布JARそのものでも確認した。Nettyのリンクは説明用のブランチ参照で、依存バージョンを固定した根拠は配布JARのバイトコードと実行結果。

## FerrumProxy側の評価

- `src/tcp.rs` は `haproxy: true` のとき TCP PROXY v2 を送る。上記signalingとのプロトコル上の互換性がある。
- `src/udp.rs` は `haproxy: true` のとき初回UDPデータグラムに PROXY v2 を付加する。これはCloudburst RakNetのマッピングを前提とした処理。
- NetherNet のWebRTC UDPは、このRakNet用ヘッダーを受け取る経路ではない。WebRTC側へ付けると正常なSTUN/DTLSデータグラムではなくなる。
- 同じlistener ruleの `haproxy` はTCPとUDPの両方に効くため、NetherNetを中継するならTCP用ruleとUDP用ruleを分ける等の対応が必要。
- 通常のUDP中継はWebRTCの物理接続先をProxyへ変えるが、Geyserの公開アドレスAPIはsignaling元IPを保持するケースがある。UDPでPROXYヘッダーを送ることは必要条件ではない。
- このリポジトリにはNetherNet signaling/SDPの解釈、ICE candidateの書き換え、WebRTCの終端処理はない。単純なTCP/UDP転送が接続成立するかは、広告アドレスとICE経路を含む追加検証が必要。

## 運用上の判断

`use-haproxy-protocol: true` と信頼するProxyの指定によりTCP signalingへ実IPを渡す構成を継続する。
今のNetherNetモード (TCP PROXY v2・UDPヘッダーなし) でも元IPを取得できる経路がある。
ただし、実Bedrockログイン後にGeyserの `GeyserSession.getSocketAddress()` と必要ならJava側でIPを観測して確定する。
設定でアドレスキャッシュによる保持を保証するスイッチは、このbuiltin経路では見つかっていない。

GeyserからJava側への伝達は別設定・別経路:

- `advanced.java.use-haproxy-protocol` が有効なら `CLIENT_PROXIED_ADDRESS` に `upstream.getAddress()` を設定する。Java側バックエンドがPROXY protocolを受け取れる場合だけ使用する。
- Floodgate認証なら `GeyserSessionAdapter` が `upstream.getAddress()` のIPを `BedrockData` に含め、暗号化してJava側へのhandshakeデータに載せる。
- Java側で表示されるIPが元IPになるかは受け取り側の構成も必要で、Geyserが持つIPとJavaサーバーのTCP接続元IPは同じとは限らない。

当初提案した「まず上流修正が必須」「透過UDP転送が必須」という説明は撤回する。
キャッシュに頼らず元IPを明示的に保持する上流改善には意味があるが、このビルドで実IP取得が不可能という証拠にはならない。
`-DgeyserAdvertiseAddresses` による公開ICEアドレス指定は到達経路の設定であり、実IPの保持処理を置き換えるものではない。
