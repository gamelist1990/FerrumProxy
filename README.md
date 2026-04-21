# FerrumProxy

FerrumProxy is an independent Rust proxy server for Minecraft Bedrock and HTTP/HTTPS forwarding. It focuses on low-latency TCP/UDP forwarding, HAProxy PROXY protocol support, Bedrock pong rewriting, TLS listener support, Discord notifications, and a REST API that can be managed from the included web GUI.

`FerrumGUI` is bundled in this repository for browser-based management of one or more FerrumProxy instances.

## Requirements

- Rust stable
- Cargo
- Bun 1.0 or later, only when building or running `FerrumGUI`
- CMake, optional wrapper for Cargo builds

## Build

With Cargo:

```bash
cargo build --release
```

With CMake as a wrapper around Cargo:

```bash
cmake -S . -B build
cmake --build build --config Release
```

The binary is created under `target/release/`.

## Cross-Platform Build Output

Local helper scripts copy finished binaries into `target/build/<platform>/`.

PowerShell:

```powershell
.\scripts\build-all.ps1
```

Bash:

```bash
./scripts/build-all.sh
```

Default platforms:

- `target/build/windows-x64/ferrum-proxy.exe`
- `target/build/linux-x64/ferrum-proxy`
- `target/build/linux-arm64/ferrum-proxy`
- `target/build/macos-x64/ferrum-proxy`
- `target/build/macos-arm64/ferrum-proxy`

Cross-compiling every target from one local OS may require extra linkers or SDKs. The GitHub Actions workflow uses native hosted runners for each OS and uploads each platform binary as an artifact.

## Run

```bash
./target/release/ferrum-proxy
```

On Windows:

```powershell
.\target\release\ferrum-proxy.exe
```

## Features

- YAML config with `endpoint`, `useRestApi`, `savePlayerIP`, `debug`, and `listeners`
- TCP forwarding
- UDP forwarding
- HAProxy PROXY protocol v2 parse/build for TCP and UDP
- DNS cache for target hostnames
- Bedrock `Unconnected Pong` advertised port rewrite
- Short shared Bedrock pong cache for reducing backend ping load
- HTTPS listener/TLS termination with manual cert paths or Linux Let's Encrypt auto-detection
- URL-style HTTP/HTTPS targets with request path/host rewrite and response `Location` rewrite
- HTTPS backend connections for `https://...` URL targets
- Discord webhook grouped connection/disconnection notifications
- REST management API for `/api/login`, `/api/logout`, and `/api/players`
- Player connection buffering and player IP persistence in `playerIP.json`
- Debug logging via `debug: true`

## FerrumProxyGUI

FerrumProxyGUI lives in `FerrumGUI`.

```bash
cd FerrumGUI
bun install
cd frontend && bun install && cd ..
bun run build:frontend
bun run generate:embed
bun run dev
```

Open `http://localhost:3000`.

Production mode:

```bash
cd FerrumGUI
bun run build:frontend
bun run generate:embed
bun run build
bun run start
```

FerrumProxyGUI downloads FerrumProxy binaries from `gamelist1990/FerrumProxy` by default. Override this when testing forks:

```bash
FERRUMPROXY_GITHUB_REPO=owner/repo FERRUMPROXY_RELEASE_TAG=FerrumProxy bun run start
```

## GitHub Actions

This repository includes two independent workflows:

- `.github/workflows/ferrumproxy-build.yml` builds and publishes FerrumProxy binaries.
- `.github/workflows/ferrumproxygui-build.yml` builds and publishes FerrumProxyGUI binaries.

Both workflows are scoped to this repository layout and do not depend on a parent BunProxy directory.

## Notes

FerrumProxy keeps a familiar YAML config shape while using Tokio tasks and Rustls internally.

If `config.yml` does not exist in the current working directory, FerrumProxy creates a default one automatically. Use `--config <path>` only when you want to load another file.

---

# FerrumProxy (日本語)

FerrumProxy は Minecraft Bedrock と HTTP/HTTPS 転送向けの独立した Rust 製プロキシサーバーです。低遅延の TCP/UDP 転送、HAProxy PROXY protocol、Bedrock pong 書き換え、TLS 待受、Discord 通知、GUI から操作できる REST API を備えています。

`FerrumGUI` には複数の FerrumProxy インスタンスを管理するための Web GUI が含まれています。

## ビルド

Cargo で:

```bash
cargo build --release
```

Cargo のラッパーとして CMake を使う場合:

```bash
cmake -S . -B build
cmake --build build --config Release
```

バイナリは `target/release/` 以下に作成されます。

## クロスプラットフォーム出力

ローカル用ヘルパースクリプトは、完成したバイナリを `target/build/<platform>/` にコピーします。

PowerShell:

```powershell
.\scripts\build-all.ps1
```

Bash:

```bash
./scripts/build-all.sh
```

既定の出力先:

- `target/build/windows-x64/ferrum-proxy.exe`
- `target/build/linux-x64/ferrum-proxy`
- `target/build/linux-arm64/ferrum-proxy`
- `target/build/macos-x64/ferrum-proxy`
- `target/build/macos-arm64/ferrum-proxy`

1つのローカル OS から全ターゲットをクロスコンパイルするには、追加の linker や SDK が必要になる場合があります。GitHub Actions では各 OS の hosted runner を使って、それぞれの platform binary を artifact としてアップロードします。

## 実行

```bash
./target/release/ferrum-proxy
```

Windows の場合:

```powershell
.\target\release\ferrum-proxy.exe
```

## 主な機能

- `endpoint`, `useRestApi`, `savePlayerIP`, `debug`, `listeners` を含む YAML config
- TCP 転送
- UDP 転送
- TCP/UDP の HAProxy PROXY protocol v2 パース/生成
- ターゲットホスト名の DNS キャッシュ
- Bedrock `Unconnected Pong` の advertised port 書き換え
- backend ping 負荷を減らす短時間共有 Bedrock pong キャッシュ
- 手動証明書または Linux Let's Encrypt 自動検出による HTTPS 待受/TLS 終端
- URL形式 HTTP/HTTPS ターゲットの request path/host rewrite と response `Location` rewrite
- `https://...` URL ターゲットへの HTTPS backend 接続
- Discord webhook の接続/切断グループ通知
- `/api/login`, `/api/logout`, `/api/players` REST 管理 API
- プレイヤー接続バッファと `playerIP.json` への IP 保存
- `debug: true` によるデバッグログ

## FerrumProxyGUI

```bash
cd FerrumGUI
bun install
cd frontend && bun install && cd ..
bun run build:frontend
bun run generate:embed
bun run dev
```

`http://localhost:3000` を開いてください。

FerrumProxyGUI は既定で `gamelist1990/FerrumProxy` の固定タグ `FerrumProxy` から FerrumProxy バイナリを取得します。別のリポジトリを使う場合は `FERRUMPROXY_GITHUB_REPO=owner/repo` を指定してください。

## GitHub Actions

このリポジトリには独立した workflow が 2 つあります。

- `.github/workflows/ferrumproxy-build.yml`: FerrumProxy 本体をビルドして固定タグ `FerrumProxy` に公開
- `.github/workflows/ferrumproxygui-build.yml`: FerrumProxyGUI をビルドして固定タグ `FerrumProxyGUI` に公開

どちらも BunProxy の親ディレクトリに依存しない構成です。

## 補足

設定形式は YAML です。内部実装は Tokio task と Rustls を使うため、細部は Rust 向けに調整しています。

カレントディレクトリに `config.yml` が無い場合、FerrumProxy は既定の設定ファイルを自動生成します。別の設定ファイルを使いたい場合だけ `--config <path>` を指定してください。
