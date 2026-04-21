# FerrumProxyGUI

複数のFerrumProxyインスタンスをブラウザから簡単に管理できるWebベースのGUIツールです。

## 主な機能

- **複数インスタンス管理** - 複数のFerrumProxyを同時に管理・運用
- **自動ダウンロード** - GitHubから最新バイナリを自動取得
- **リアルタイムログ** - WebSocketでコンソール出力を即座に表示
- **設定エディタ** - config.ymlをGUIで編集可能
- **HTTPS設定UI** - ListenerごとにHTTPS待受、Let's Encrypt自動検知、PEMアップロードを設定可能
- **認証機能** - パスワード保護でセキュアに管理
- **多言語対応** - 日本語・英語に対応
- **ダーク/ライトモード** - テーマ切り替え対応

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

## 使い方

### 初回セットアップ

1. ブラウザで `http://localhost:3000` を開く
2. 初回アクセス時に認証設定を促されます（任意のユーザー名とパスワードを設定）

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
2. Ubuntu / Linux なら `Let's Encrypt を自動検知` をオンにしてドメインを入力
3. 手動証明書を使う場合は `TLS証明書パス` と `TLS秘密鍵パス` を入力
4. GUIから直接PEMファイルをアップロードする場合は、証明書PEMと秘密鍵PEMを選んで `TLSファイルをアップロード` を押す
5. 保存後に FerrumProxy を再起動


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

