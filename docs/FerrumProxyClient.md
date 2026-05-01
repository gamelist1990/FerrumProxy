# FerrumProxy Client

FerrumProxy Client は共有サービス mode 用のユーザー側アプリです。FerrumProxyGUI とは役割が異なり、relay サーバーへ outbound 接続してユーザーのローカル TCP/UDP サービスへ中継します。

## 役割

- relay の `ip:port` に接続します。
- TCP、UDP、または両方を選べます。
- ローカルのサービス port を指定します。
- 必要なら HAProxy PROXY protocol を使います。

## GUI

Client 側には Tauri ベースの GUI があります。

```bash
bun install
cd frontend && bun install && cd ..
bun run tauri:build
```

## CLI

```bash
bun run cli -- --relay 203.0.113.10:7000 --protocol both --tcp-port 25565 --udp-port 25565 --haproxy
```

主なオプション:

- `--relay <ip:port>`: relay の control endpoint
- `--protocol <tcp|udp|both>`: 転送モード
- `--tcp-port <port>`: ローカル TCP port
- `--udp-port <port>`: ローカル UDP port
- `--haproxy`: ローカルサービス向けに PROXY protocol を有効化

## 共有サービスとの関係

Client は relay の管理 UI ではありません。以下の責務を持ちます。

- 管理画面ではなく、利用者のローカル環境で動きます。
- relay が払い出した一時 public port を使います。
- 永続 public port を予約する設計ではありません。

共有サービス relay 側の設定は [FerrumProxyGUI.md](FerrumProxyGUI.md) と [configuration.md](configuration.md) を参照してください。

## 補足

- GUI 版と CLI 版は同じ Client の別入力口です。
- relay の token は `fp_...` 形式の opaque token として扱います。
- local port や protocol の選択は Client 側で完結します。
