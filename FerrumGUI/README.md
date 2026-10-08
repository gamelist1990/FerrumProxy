# FerrumProxyGUI

複数のFerrumProxyインスタンスをブラウザから簡単に管理できるWebベースのGUIツールです。

## 主な機能

- **複数インスタンス管理** - 複数のFerrumProxyを同時に管理・運用
- **自動ダウンロード** - GitHubから最新バイナリを自動取得
- **GUIの自動更新** - ダウンロードを検証してから管理プロセスと旧GUIを停止。別プロセスの更新ヘルパーが実行ファイルを差し替えて同じ起動引数・作業フォルダーでGUIを起動し、ブラウザーは新しいバージョンの起動を確認して再読み込みします。ヘルパーは完了後に終了します。差し替えに失敗した場合は旧バイナリを復元し、原因を実行ファイルの隣の `.update.log` に記録します。
- **リアルタイムログ** - WebSocketでコンソール出力を即座に表示
- **設定エディタ** - config.ymlをGUIで編集可能
- **インスタンス設定ページ** - ページ全体を使い、基本情報・起動と復旧・Manager API・証明書とGeyser・バージョン更新を切り替えて編集
- **HTTPS設定UI** - ListenerごとにHTTPS待受、Let's Encrypt自動検知、PEMアップロードを設定可能
- **認証機能** - パスワード保護でセキュアに管理
- **多言語対応** - 日本語・英語に対応
- **ダーク/ライトモード** - テーマ切り替え対応
- **共有サービス relay 管理** - 中継サーバー側の有効化と limits を管理
- **FerrumProxy Client** - ユーザーインストール型の Tauri GUI / CLI として別ビルド

## 必要な環境

- Bun 1.0以降（推奨）または Node.js 18以降
- 対応OS: Linux / macOS / Windows

## インストール

```bash
# FerrumProxy リポジトリ内の FerrumGUI へ移動
cd FerrumGUI

# 依存関係をインストール
bun install
cd frontend && bun install && cd ..

# フロントエンドをビルド
bun run build:frontend
```

## 起動方法

### 開発モード

```bash
bun run alldev
```

`http://localhost:3000` にアクセスしてください。

### 本番モード

```bash
bun run build
bun run start
```

### HTTPSで起動

TLS証明書と秘密鍵を指定すると、FerrumProxyGUI 自体を HTTPS で起動できます。HTTPSで開いた場合、WebSocketも自動的に `wss://` へ切り替わります。

```bash
FERRUMPROXYGUI_TLS_CERT=/path/to/fullchain.pem \
FERRUMPROXYGUI_TLS_KEY=/path/to/privkey.pem \
bun run start
```

Windows PowerShell の例:

```powershell
$env:FERRUMPROXYGUI_TLS_CERT="C:\path\to\fullchain.pem"
$env:FERRUMPROXYGUI_TLS_KEY="C:\path\to\privkey.pem"
bun run start
```

### スタンドアロン実行ファイルの作成

FerrumProxyGUIは、フロントエンドの静的ファイルを埋め込んだスタンドアロン実行ファイルとして配布できます。

```bash
# まずフロントエンドをビルド
bun run build:frontend

# 現在のプラットフォーム用
bun run build:compile

# すべてのプラットフォーム用（Linux/macOS/Windows）
bun run build:all
```

生成されたバイナリを実行するだけで、Node.js/Bunのインストール不要で動作します。フロントエンドの静的ファイルもバイナリに埋め込まれているため、`public`ディレクトリも不要です。

**ビルドされるファイル:**
- `ferrumproxy-gui-linux` - Linux x64
- `ferrumproxy-gui-linux-arm64` - Linux ARM64
- `ferrumproxy-gui-macos-arm64` - macOS ARM64
- `ferrumproxy-gui-windows.exe` - Windows x64

### systemdサービスでのGUI更新

`sudo systemctl restart ferrumproxy` などで起動している場合も、GUIの更新後に新しいバージョンの起動を確認してブラウザーを再読み込みします。サービス名は実行中プロセスのcgroupとsystemdのMainPID・InvocationIDから検出します。`ExecStart` はコンパイル済みのGUI実行ファイルを直接起動してください。

Linuxのsystemd起動では、GUIが稼働している間に実行ファイルをアトミックに差し替え、HTTPの更新応答を送信した後でサービスを再起動します。rootのサービスとユーザーサービスはsystemdに再起動を要求します。一般ユーザーで動くシステムサービスは、既存の `Restart=always` / `on-success` / `on-failure` に対応する終了コードを使用します。`Restart=on-failure` では更新時に非ゼロで終了するため、journalに終了ステータスが記録されますが、その後の新バージョン起動まで確認します。

一般ユーザーで動くサービスには次の設定を推奨します。サービスの実行ユーザーに、GUI実行ファイルがあるディレクトリーへの書き込み権限が必要です。

```ini
[Service]
Restart=always
RestartSec=3
ExitType=main
```

`KillMode=control-group` はそのまま利用できます。更新用の子プロセスに再起動を任せないため、GUI停止時に子プロセスが一緒に終了しても更新できます。`RestartSec` に合わせてブラウザー側の待機時間も調整します。自動再起動できない構成は、管理中のプロキシを停止する前にエラーを返します。サービスの権限や設定を自動変更することはありません。

この処理は修正版GUIの導入後に有効になります。旧GUIの更新ヘルパーがsystemdによって停止されてしまう環境では、修正版の初回差し替えとサービス再起動を一度行ってください。

Ubuntuのsystemdで行う隔離テスト（rootの検証VM内で、一時的なテストサービスだけを作成・削除します）:

```bash
FERRUM_GUI_TEST_SYSTEMD=1 bun test tests/systemdUpdateIntegration.test.ts
```

`Restart=no` のrootサービスと、`Restart=always` / `on-failure` の一般ユーザーサービスを、既定の `KillMode=control-group` のまま検証します。

## 使い方

### インスタンス設定

インスタンスを選び、操作欄の「設定」を開くと専用ページへ移動します。左側の項目で設定を切り替え、画面下の「インスタンス設定を保存」で変更をまとめて保存します。保存後も同じページに留まり、反映結果を表示します。未保存の変更がある状態で戻る際は確認します。スマートフォンでは項目が画面上部に並びます。

「プロキシ設定へ」から、転送ルート・保護・接続などの既存設定エディタに移動できます。証明書登録やトークン発行はそれぞれのボタンで即時保存します。Manager設定はインスタンスを再起動して反映します。

Geyserの `manager-token.txt` にはManager APIの管理トークンを使えます。証明書の取得だけを許可する拡張用トークンも発行できます。拡張用トークンで接続確認する際は、`/api/v1/health` ではなく `/api/v1/certificates/証明書ID` を使用してください。

### 初回セットアップ

1. ブラウザで `http://localhost:3000` を開く
2. 初回アクセス時に認証設定を促されます（任意のユーザー名とパスワードを設定）

### 公開時の保護設定

GUI を外部公開する場合は、既定の rate limit と User-Agent フィルタを有効にしたまま使うのが前提です。必要に応じて以下の環境変数で調整できます。

- `FERRUMPROXYGUI_RATE_LIMIT_PER_MINUTE` - 一般 HTTP リクエストの許容量
- `FERRUMPROXYGUI_AUTH_RATE_LIMIT_PER_MINUTE` - `/api/auth/*` の許容量
- `FERRUMPROXYGUI_WEBSOCKET_RATE_LIMIT_PER_MINUTE` - WebSocket 接続試行の許容量
- `FERRUMPROXYGUI_BLOCKED_USER_AGENTS` - 追加で拒否する User-Agent 断片をカンマ区切りで指定

空の User-Agent や、`curl` / `wget` / `python-requests` / `nmap` / `sqlmap` などのスキャナ系 User-Agent は既定で拒否されます。

### インスタンスの作成

1. サイドバーの「新規インスタンス作成」セクションに入力
   - インスタンス名を入力
   - プラットフォームを選択（Linux/macOS/Windows）
   - バージョンを選択（latest または特定バージョン）
2. 「インスタンス作成」をクリック
3. 自動的にバイナリがダウンロードされ、初期化されます

### インスタンスの操作

- **起動** - 停止中のインスタンスを起動
- **停止** - 実行中のインスタンスを停止
- **再起動** - インスタンスを再起動
- **削除** - インスタンスを完全に削除

### ログの確認

インスタンスを選択すると、リアルタイムでログが表示されます。標準出力・標準エラー・システムメッセージを色分けして表示します。

### 設定の編集

1. インスタンスを選択
2. 「設定」セクションでconfig.ymlの内容を編集
3. 「設定を保存」をクリック
4. インスタンスを再起動して反映

### HTTPS待受の設定

1. Listener の `HTTPS待受を有効化` をオン
2. Ubuntu / Linux で `certbot` をインストールし、外部からTCP 80番へ到達できる状態にする
3. 同じIPで使用するドメインをカンマ区切りで入力する。例: `example.com, api.example.com`
4. `証明書がなければ自動取得` をオンにすると、設定保存時に未取得のSAN証明書を自動取得する
5. 即時確認する場合は `証明書を確認・取得` を押す
6. 手動証明書を使う場合は `TLS証明書パス` と `TLS秘密鍵パス` を入力
7. GUIから直接PEMファイルをアップロードする場合は、証明書PEMと秘密鍵PEMを選んで `TLSファイルをアップロード` を押す
8. 保存後に FerrumProxy を再起動

### 共有サービス relay

FerrumProxyGUI は中継サーバー上で動作する管理用ソフトウェアです。ユーザーのローカルサービス port や HAProxy の有効/無効は Client 側で設定します。

FerrumProxyGUI では config editor の `Shared Service Relay` から以下を設定します。

1. relay の有効/無効
2. 最大 TCP 接続数
3. 最大 UDP peer 数
4. 帯域制限
5. TCP idle timeout
6. UDP session timeout

公開時の bind は `0.0.0.0` 前提です。公開 share port は relay が一時的に払い出し、永続予約は行いません。

### FerrumProxy Client

Client はユーザーPCにインストールして使う共有用アプリです。`FerrumClient/` に分離されています。

```bash
cd ../FerrumClient

# GUI build
bun run tauri:build

# CLI example
bun run cli -- --relay 203.0.113.10:7000 --protocol both --tcp-port 25565 --udp-port 25565 --haproxy
```

Client 側では relay の `ip:port`、TCP/UDP、ローカルサービス port、HAProxy PROXY protocol の有効/無効を指定します。


## トラブルシューティング

### ポートが使用中

```bash
PORT=4000 bun run start
```

環境変数でポートを変更できます。

### Linux/macOSで低ポートを使う場合

Linux/macOSでは、設定内の `endpoint` / Listener の `tcp` / `udp` が `1-1023` の低ポートの場合だけ `sudo` 経由で起動します。通常の Minecraft ポートなどでは sudo を使わず、そのまま起動します。

ただし、GUIからの起動は**非対話**のため sudo パスワード入力プロンプトは表示できません。必要に応じて以下のいずれかを行ってください。

- FerrumProxyGUI自体を管理者権限で起動する
- 対象バイナリ実行を `sudoers` で `NOPASSWD` 許可する

### GitHub APIレート制限

無料アカウントでは1時間あたり60リクエストの制限があります。レート制限に達した場合、固定タグ `FerrumProxy` の最新ビルドを既定として扱います。

FerrumProxy のリリース取得先は既定で `gamelist1990/FerrumProxy` の `FerrumProxy` タグです。別リポジトリやタグから取得したい場合は `FERRUMPROXY_GITHUB_REPO=owner/repo` / `FERRUMPROXY_RELEASE_TAG=FerrumProxy` を指定してください。

### WebSocket接続エラー

ファイアウォールでポート3000を許可してください。

## 開発に参加する

プルリクエストを歓迎します！バグ報告や機能提案もIssueでお待ちしています。

## ライセンス

MIT License

---

**関連リンク**
- [FerrumProxy本体](https://github.com/gamelist1990/FerrumProxy)
- [FerrumProxyリリース](https://github.com/gamelist1990/FerrumProxy/releases)
