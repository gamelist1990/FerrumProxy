# FerrumProxyGUI

FerrumProxyGUI は複数の FerrumProxy インスタンスをブラウザから管理する Web ベースの GUI です。設定編集、ログ表示、インスタンス操作、共有サービス relay の管理を行います。

## 役割

- 複数インスタンスの起動・停止・再起動・削除を扱います。
- `config.yml` を GUI で編集します。
- HTTPS 待受の証明書設定を扱います。
- 共有サービス relay の limits と token 発行を管理します。

FerrumProxy 本体の設定仕様は [FerrumProxy.md](FerrumProxy.md) と [configuration.md](configuration.md) を参照してください。listener 個別の説明は [listeners.md](listeners.md) にあります。

## 主な機能

- インスタンス管理
- 自動ダウンロード
- リアルタイムログ
- 設定エディタ
- HTTPS 設定 UI
- 認証機能
- 共有サービス relay 管理
- FerrumProxy Client の配布用ビルド

## 共有サービス relay

GUI の shared-service 画面は、公開リレー側の設定を管理するためのものです。

- `enabled`: relay の有効化
- `defaults`: 既定の制限
- `maximums`: 設定上限
- `portRange`: 一時ポート範囲
- `queue`: 待機キュー
- `authTokens`: 旧方式の token 群
- `tokens`: 個別トークン設定

GUI から発行される token は `fp_` で始まる opaque な文字列です。発行された token は `sharedService.tokens[].token` に保存され、relay 側で照合されます。

## HTTPS 設定

Listener ごとに次を設定できます。

- HTTPS 待受の有効/無効
- Let's Encrypt の自動検知
- PEM 証明書のアップロード
- `certPath` / `keyPath` の手動指定

設定の詳細は [configuration.md](configuration.md) と [listeners.md](listeners.md) を参照してください。

## 起動

```bash
cd FerrumGUI
bun install
cd frontend && bun install && cd ..
bun run build:frontend
bun run generate:embed
bun run dev
```

本番起動では `bun run build` と `bun run start` を使います。

## 補足

- GUI は既定で `gamelist1990/FerrumProxy` の release を取得します。
- Fork を使う場合は `FERRUMPROXY_GITHUB_REPO=owner/repo` を指定できます。
- 管理 UI と relay 本体は別コンポーネントなので、公開 port と管理 port を分けて運用するのが基本です。
