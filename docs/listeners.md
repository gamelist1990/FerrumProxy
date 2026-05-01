# Listener 設定

FerrumProxy の listener は、TCP、UDP、HTTPS、Webhook、HTTP/HTTPS の path mapping をまとめて定義する入口です。1 つの listener が 1 つの公開面を表します。

設定の定義は [src/config.rs](../src/config.rs) と [src/tls_config.rs](../src/tls_config.rs) にあります。

## 基本形

```yaml
listeners:
  - bind: 0.0.0.0
    tcp: 25565
    udp: 25565
    haproxy: false
    https:
      enabled: false
      autoDetect: true
    rewriteBedrockPongPorts: true
    webhook: ""
    target:
      host: 127.0.0.1
      tcp: 19132
      udp: 19132
```

## 各項目

### `bind`

- 待受アドレスです。
- 既定値は `0.0.0.0` です。

### `tcp` / `udp`

- それぞれの待受ポートです。
- 片方だけ設定することもできます。
- 両方指定した場合は、同じ listener で TCP と UDP を公開します。

### `haproxy`

- HAProxy PROXY protocol v2 の受け取りと送出を有効にします。
- 前段のロードバランサや別の proxy と連携する場合に使います。

### `https`

TLS 待受の設定です。`enabled: true` にすると HTTPS を受けます。

- `enabled`: TLS の有効/無効
- `autoDetect`: 証明書の自動検出を使うかどうか
- `letsEncryptDomain`: Linux での Let's Encrypt 自動検出に使うドメイン
- `certPath`: 手動証明書の PEM パス
- `keyPath`: 手動秘密鍵の PEM パス

### `rewriteBedrockPongPorts`

- Bedrock の Unconnected Pong に含まれる advertised port を書き換えます。
- 既定値は `true` です。

### `webhook`

- 接続や切断を通知する webhook URL です。
- 空文字なら無効です。

### `target` / `targets`

- `target` は単一転送先です。
- `targets` は複数転送先の配列です。
- `targets` が空なら `target` が使われます。

各 target は次を持ちます。

- `host`: 転送先ホスト名、または URL 形式のホスト
- `tcp`: TCP 転送先ポート
- `udp`: UDP 転送先ポート

### `httpMappings`

HTTP/HTTPS の path ベース振り分けです。

- `path`: マッピングの起点
- `target` / `targets`: その path に対する転送先

挙動:

- 最長一致の path が選ばれます。
- `/pages` は `/pages/example` にもマッチします。
- `/` は全体のフォールバックです。

## HTTPS の制約

- `autoDetect` は Linux 前提です。
- `autoDetect: false` の場合は `certPath` と `keyPath` を明示してください。
- `enabled: true` でも証明書情報が無いと起動できません。

## 参照先

- 具体的な config の全体像は [configuration.md](configuration.md)
- FerrumProxy 本体の説明は [FerrumProxy.md](FerrumProxy.md)
- GUI 側の listener 操作は [FerrumProxyGUI.md](FerrumProxyGUI.md)
