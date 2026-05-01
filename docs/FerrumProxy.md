# FerrumProxy

FerrumProxy は Minecraft Bedrock と HTTP/HTTPS 転送向けの独立した Rust 製プロキシサーバーです。低遅延の TCP/UDP 転送、HAProxy PROXY protocol、Bedrock pong 書き換え、TLS 待受、Discord 通知、REST API を提供します。

## 役割

- Minecraft Bedrock の TCP/UDP を中継します。
- HTTP/HTTPS の URL ベース転送を扱います。
- 管理 API を通じて GUI から設定を編集できます。
- 共有サービス relay の本体として動作できます。

## 主要設定

設定の詳細は [configuration.md](configuration.md) を参照してください。

特に重要な項目は次の通りです。

- `endpoint`: 管理 API の待受ポート
- `useRestApi`: REST API の有効化
- `savePlayerIP`: プレイヤー IP の保存
- `debug`: デバッグログ
- `listeners`: TCP/UDP/HTTPS の待受ルール
- `sharedService`: 共有サービス relay の設定

共有サービス relay の token 形式や制限値の考え方は [shared-service-design.md](shared-service-design.md) と [configuration.md](configuration.md) の `sharedService` 節を参照してください。listener の詳細は [listeners.md](listeners.md) を参照してください。

## リスナー

各 listener は 1 つの入口です。

- `bind`: 待受アドレス
- `tcp` / `udp`: 待受ポート
- `haproxy`: PROXY protocol v2 の利用
- `https`: TLS 待受の有効化と証明書指定。詳細は [listeners.md](listeners.md)
- `target` / `targets`: 転送先
- `httpMappings`: パスベースの HTTP/HTTPS 転送

URL 形式の転送先は `http://` や `https://` を含めて指定できます。HTTP のパス書き換えや response `Location` の書き換えもここに含まれます。

## 起動

```bash
cargo build --release
./target/release/ferrum-proxy
```

Windows の場合は `ferrum-proxy.exe` を実行します。

## 運用の注意点

- `config.yml` が存在しない場合は起動時に既定値入りの設定が生成されます。
- `--config <path>` を使うと別ファイルを読み込めます。
- 共有サービス relay を公開する場合は、`publicBind` と `controlBind` を分けて考えてください。
- HTTPS を使う場合は、Linux の自動検出か手動証明書指定かを先に決めておくと混乱しません。
