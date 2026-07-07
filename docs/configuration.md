# FerrumProxy 設定詳細

このドキュメントは FerrumProxy の `config.yml` を項目ごとに説明します。設定の実体は [src/config.rs](../src/config.rs) にあります。

## まず押さえること

- FerrumProxy は起動時に `config.yml` を読みます。
- ファイルが存在しない場合は、既定値入りの `config.yml` を自動生成します。
- `--config <path>` を付けると、別の YAML ファイルを読み込めます。
- YAML のキーは `camelCase` です。`savePlayerIP` や `sharedService` のように書きます。

## トップレベル設定

### `endpoint`

- 管理 API の待受ポートです。
- 既定値は `6000` です。

### `useRestApi`

- GUI や外部ツール向けの REST API を有効にします。
- 既定値は `false` です。

### `savePlayerIP`

- プレイヤー接続時の IP 情報を保存します。
- 既定値は `true` です。

### `debug`

- デバッグログを有効にします。
- 既定値は `false` です。

### `listeners`

- TCP/UDP/HTTPS の待受ルール一覧です。
- 詳細は [listeners.md](listeners.md) を参照してください。
- 1 つ以上必要です。
- ルールごとに単一ターゲットか複数ターゲットを設定できます。
- HTTP/HTTPS のパスベース転送もここで定義します。

## `sharedService`

共有リレー機能全体の設定です。`enabled: true` にすると、公開リレーとして動きます。

### `enabled`

- 共有リレー機能の有効/無効です。
- 既定値は `false` です。

### `controlBind`

- 制御用 TCP の待受アドレスです。
- 既定値は `0.0.0.0:7000` です。

### `publicBind`

- 共有クライアントが接続する公開待受アドレスです。
- 既定値は `0.0.0.0` です。

### `publicHost`

- クライアントへ案内する公開ホスト名です。
- 空文字でも動作しますが、外部公開するなら DNS 名や固定 IP を入れておく方が分かりやすいです。

### `portRange`

- クライアントへ払い出す一時ポートの範囲です。
- `start` の既定値は `40000`。
- `end` の既定値は `49999`。
- 固定ポートがこの範囲外なら拒否されます。

### `authTokens`

- 旧方式の認証トークン配列です。
- 文字列をそのまま列挙します。
- `CONNECT token:host:port` の token 部分と照合されます。
- 既定値は空配列です。

### `allowAnonymous`

- `host:port` 形式の匿名接続を許可します。
- 既定値は `true` です。
- `false` の場合は token 付き接続のみ受け付けます。

### `queue`

待機キューの設定です。

- `enabled`: キュー有効/無効。既定値は `true`。
- `maxSize`: 待機中クライアントの上限。既定値は `128`。

### `tokens`

新しいトークン管理方式です。個別トークンに名前、固定ポート、優先度、制限を持たせます。

GUI から発行される共有サービス token は、現在は `fp_` で始まる opaque な文字列です。内部的には乱数ベースで生成され、`sharedService.tokens[].token` にそのまま保存して照合します。

形式の目安:

- 例: `fp_d8da93bf7a7599efb8c44ca0bdc101659dd789db2acc4e13`
- 接頭辞の `fp_` は FerrumProxy の共有サービス token を示す目印です。
- 後半は base64url 系のランダム値です。
- 文字列の見た目は仕様の本体ではなく、あくまで opaque token として扱います。

各要素の項目:

- `name`: 表示名です。空でも動作します。
- `token`: 実際に照合する文字列です。必須です。
- `enabled`: 有効/無効です。既定値は `true`。
- `fixedPort`: このトークンに割り当てる固定ポートです。`portRange` の範囲内である必要があります。
- `priority`: 同時利用時の優先度です。既定値は `10`。
- `limits`: このトークンに適用する上限値です。

補足:

- 有効で空でない `token` が、実際に利用可能なトークンとして数えられます。
- `name` は空欄でもよく、管理用途のラベルとして使う想定です。
- `fixedPort` が設定されている場合、範囲外だと接続は失敗します。
- GUI で発行した token は、`authTokens` のような手書き文字列とは別枠で管理する前提です。

### `defaults`

新規に確保される共有サービスの既定制限です。

- `maxBytesPerSecond`: 既定 `10485760` で、およそ 10 MiB/s
- `idleTimeoutSeconds`: 既定 `120`
- `udpSessionTimeoutSeconds`: 既定 `60`

### `maximums`

設定可能な上限の上限値です。`defaults` や `tokens[].limits` の値を設計するときのガードレールとして使います。

- `maxBytesPerSecond`: 既定 `104857600` で、およそ 100 MiB/s
- `idleTimeoutSeconds`: 既定 `3600`
- `udpSessionTimeoutSeconds`: 既定 `600`

## `listeners` 参照

listener の項目ごとの説明は [listeners.md](listeners.md) にまとめています。

## 既定の設定例

以下は `config.rs` の既定値に合わせた最小構成のイメージです。

```yaml
endpoint: 6000
useRestApi: false
savePlayerIP: true
debug: false
sharedService:
  enabled: false
  controlBind: 0.0.0.0:7000
  publicBind: 0.0.0.0
  publicHost: ""
  portRange:
    start: 40000
    end: 49999
  authTokens: []
  allowAnonymous: true
  queue:
    enabled: true
    maxSize: 128
  tokens: []
  defaults:
    maxBytesPerSecond: 10485760
    idleTimeoutSeconds: 120
    udpSessionTimeoutSeconds: 60
  maximums:
    maxBytesPerSecond: 104857600
    idleTimeoutSeconds: 3600
    udpSessionTimeoutSeconds: 600
listeners:
  - bind: 0.0.0.0
    tcp: 25565
    udp: 25565
    haproxy: false
    https:
      enabled: false
      autoDetect: true
    webhook: ""
    rewriteBedrockPongPorts: true
    target:
      host: 127.0.0.1
      tcp: 19132
      udp: 19132
```

## 実運用の注意点

- 共有リレーを公開するなら `publicBind` は `0.0.0.0` のままにし、`controlBind` は外部公開しない構成が無難です。
- `authTokens` は旧方式、`tokens` は個別設定向けです。新規構成では `tokens` を中心に組む方が管理しやすいです。
- `fixedPort` を使う場合は、`portRange` と整合しているか必ず確認してください。
- HTTPS を有効にする前に、証明書の配置方法を `autoDetect` か手動指定かで決めておくと混乱しません。
