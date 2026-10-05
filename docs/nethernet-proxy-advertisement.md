# FerrumProxyによるNetherNet公開UDP候補の広告

NetherNetリスナーに公開ProxyのIPを指定すると、`/v1/join` から始まるHTTP接続の成功SDP応答に公開UDP候補を追加します。Geyserの `-DgeyserAdvertiseAddresses` はこの方式では不要です。既存の候補、ICE資格情報、identity、fingerprintは保持します。クライアントのofferは変更しません。

```json
{
  "bind": "0.0.0.0",
  "tcp": 19132,
  "udp": 19132,
  "bedrockTransport": "nethernet",
  "haproxy": true,
  "nethernetAdvertiseHost": "132.145.118.98",
  "nethernetAdvertisePort": 19132,
  "targets": [{"host": "100.83.127.8", "tcp": 19132, "udp": 19132}]
}
```

`nethernetAdvertiseHost` はDNS名ではなくIPv4/IPv6のリテラルを指定します。未指定なら既存の転送動作です。`nethernetAdvertisePort` は省略するとリスナーの `udp` を使います。外部NATでポート変換している場合は、インターネットから到達できるポートを明示してください。

HTTP signalingとWebRTC UDPのGeyser側ポートが異なる場合は、targetsのtcp/udpを各待受ポートに合わせます。公開ポートとbackend UDPポートが異なる場合もcandidateの公開ポートを独立して指定できます。HTTPマッピングでsignalingを別のbackendへ送る場合、そのbackendへ対応するUDP転送も必須です。

GUIのNetherNet設定に「公開IP」「公開UDPポート」を追加しています。GUIだけでなくRustのFerrumProxy本体も更新してください。稼働サーバーにはこの作業から自動配布・再起動していません。

Content-Length、chunked、接続終了で区切られたHTTP/1.x応答、同じTCP接続上のGET→POSTに対応。signaling応答は最大1MiB、ヘッダーは64KiB。圧縮SDPは未対応でエラーにします（Geyserの今回の応答は非圧縮）。backendまでTLSを暗号化したまま透過転送する構成ではSDPを読めません。公開側TLSをFerrumProxyで終端する構成は対象です。

確認手順：新しい本体と設定で再起動し、Tailscale OFFのBedrockクライアントで接続します。Proxyからクライアントへ返るSDPに `132.145.118.98 19132 typ srflx` があることと、UDPの往復を確認してください。Tailscale側のキャプチャは書き換え前のGeyser応答なので、そこに公開候補が追加されていなくても正常です。認証情報を含むSDP本文全体は共有しないでください。

この機能は接続候補を広告する機能です。外部ファイアウォールの開放、UDP到達性、backendへの転送、実IPの取得を独立して確認する必要があります。ローカルのHTTPフレーミング・SDP補正テストと既存のNetherNet UDP転送テストで検証し、実サーバーの認証済みゲーム参加は未検証です。
