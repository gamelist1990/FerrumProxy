# 共有サービス設計

FerrumProxy の共有サービス機能は、リレー側の設定を [configuration.md](configuration.md) にまとめています。ここでは設計の位置づけだけを簡潔に示します。

- `FerrumProxyGUI` は中継サーバー側の管理 UI です。
- `FerrumProxy Client` は利用者側の接続アプリです。
- 公開リレーは一時ポートを払い出す設計で、クライアント側に永続 port を持たせません。
- トークンや制限値の詳細は [configuration.md](configuration.md) の `sharedService` 節を参照してください。

運用上は、リレーの公開待受と管理待受を分け、`allowAnonymous`、`authTokens`、`tokens`、`portRange` を用途に応じて組み合わせます。
