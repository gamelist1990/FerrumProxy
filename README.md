# FerrumProxy

**FerrumProxy** is a Rust-native reverse proxy for Minecraft Bedrock and HTTP/HTTPS traffic. It’s built on Tokio + Rustls and is designed for one thing: forwarding real-world traffic with **low latency**, **low CPU**, and **zero surprises** — while giving you a browser-based control plane (`FerrumProxyGUI`) so you never have to hand-edit YAML on a live host.

> Minecraft Bedrock, Java, HTTPS reverse proxy, HAProxy PROXY protocol v2, TLS termination, per-IP DDoS guard, shared relay for public port sharing — all in a single static Rust binary.

## Why FerrumProxy

Most proxy stacks are either:

- **general-purpose** (nginx / HAProxy) — great, but Bedrock RakNet and Bedrock pong rewriting need custom logic;
- or **Node/Bun scripts** — easy to hack on, but you eat GC pauses, extra syscalls, and lose UDP throughput.

FerrumProxy is a small, focused Rust binary that only does the parts of proxying that matter for game servers and reverse proxies, with a control-plane GUI on top.

### Performance-first design

| Area                          | What FerrumProxy does                                                                                          | Why it matters                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Runtime**                   | Native Rust binary on Tokio, single static executable (~9 MB), no VM, no GC.                                   | Predictable tail latency — no stop-the-world pauses under load.                          |
| **TCP forwarding**            | `tokio::spawn` per connection, `AsyncRead`/`AsyncWrite` copy loops.                                            | Handles bursty HTTP/HTTPS and Java connections without per-connection overhead.         |
| **UDP / Bedrock**             | One shared UDP server socket + one upstream socket per session, keyed by client `SocketAddr`.                  | RakNet stays intact; no per-packet allocations in the hot path.                         |
| **Bedrock pong**              | Rewrites the advertised port in Unconnected Pong on the fly + shared pong cache with immediate reply.          | Backend ping cost drops sharply; MOTD, player counts and version fields stay correct.   |
| **DNS**                       | Async DNS cache for target hostnames.                                                                          | Removes repeated `getaddrinfo` from the hot path when your targets are DNS-named.       |
| **HAProxy PROXY protocol v2** | Zero-copy binary parse and build for both TCP and UDP.                                                         | You can chain FerrumProxy behind another load balancer and preserve the real client IP. |
| **TLS termination**           | Rustls-based HTTPS listener with manual cert paths or Linux Let's Encrypt auto-detect.                          | Terminate TLS at the edge without pulling in OpenSSL.                                    |
| **HTTP/HTTPS URL targets**    | URL-style targets with request path/host rewrite and response `Location` rewrite; longest-path wins mappings.  | Route `/`, `/docs`, `/api` to different upstreams from one listener.                    |
| **DDoS guard**                | Per-IP token buckets for TCP conn/s, UDP pps and bps, plus max active TCP conns and max UDP datagram size.     | Cheap in-process protection that survives packet floods without touching iptables.      |
| **Shared relay**              | Optional mode where the public relay hands out temporary public ports over a control channel.                  | Users can publish a local service through your relay without permanent port reservations. |

### Rough numbers

> These are order-of-magnitude figures on a small VPS (2 vCPU, 2 GB RAM, Linux x64). Do your own benchmarks — network, kernel, and backend RTT dominate real deployments.

- **Idle RSS**: ~10 MB for the FerrumProxy binary itself.
- **Bedrock pong**: cached response served in the microsecond range without touching the backend, until the cache TTL expires.
- **TCP throughput**: bottlenecked by kernel and backend, not by the proxy; forwarding overhead is dominated by `copy_bidirectional` syscalls.
- **UDP capacity**: sized so a single 2 vCPU box comfortably handles hundreds of concurrent Bedrock sessions with the default DDoS-guard limits.

`FerrumProxyGUI` is bundled in this repository for browser-based management of one or more FerrumProxy instances.

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

## Shared Service Mode

FerrumProxy shared service is split into two roles:

- `FerrumProxyGUI` is the relay-server management app. It manages the FerrumProxy instance running on the public relay server and exposes relay limits in the config editor.
- `FerrumProxy Client` lives in `FerrumClient/` as the user-installed app/CLI. It connects outbound to the relay `ip:port`, selects TCP, UDP, or both, chooses local service ports, and controls whether HAProxy PROXY protocol is used.

Public relay listeners bind on `0.0.0.0`, and public share ports are temporary. Users do not reserve permanent public ports from the client.

See [`docs/shared-service-design.md`](docs/shared-service-design.md) for the current design.

See [`docs/manager-api.md`](docs/manager-api.md) for the FerrumProxy Manager API and FerrumProxyGUI proxy API.

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

### DDoS guard from the GUI (one click)

DDoS thresholds no longer need YAML edits. Open the instance’s **Config** tab and you’ll see a **DDoS Guard** card with three presets:

- **Balanced (default)** — safe for HTTP/HTTPS reverse proxying (many parallel browser connections) and Bedrock traffic at the same time.
- **Strict (Bedrock)** — tighter TCP conn/s and UDP pps; a good starting point when a single Bedrock server sits behind FerrumProxy.
- **Off (trusted upstream)** — disables the in-process guard when a real load balancer / CDN in front of you already handles this.

A collapsible **advanced** section lets you fine-tune each token bucket: `tcpMaxActivePerIp`, `tcpNewConnectionsPerSecond`, `tcpNewConnectionBurst`, `udpPacketsPerSecond`, `udpPacketBurst`, `udpBytesPerSecond`, `udpByteBurst`, `udpMaxDatagramBytes`. The defaults exactly match FerrumProxy’s `DdosGuardSettings::default()` in Rust, so flipping only the toggle keeps behavior identical to running FerrumProxy standalone.

### Self-update (version.json based)

Release binaries live under fixed tags (`FerrumProxy`, `FerrumProxyGUI`, `FerrumProxyClient`), and each release ships a `version.json` manifest describing the exact commit/date-based version and per-platform asset URLs.

The GUI:

1. Fetches `version.json` from the release directly over HTTPS — **no GitHub REST API is used**, so update checks don’t hit the 60/hour anonymous rate limit.
2. Compares the manifest version against the currently running one using **exact equality** (commit-based, not semver).
3. When updating, resolves the platform-specific asset via `assets[].platform` instead of relying on the filename embedding the version.

A compiled `FerrumProxyGUI` binary can update itself in place from the header **Update GUI** button. The bulk **Check & Update All** button applies the same version.json flow to every managed FerrumProxy instance.

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

## 共有サービスモード

FerrumProxy の共有サービスは役割を明確に分けます。

- `FerrumProxyGUI` は中継サーバー上で動作する管理用ソフトウェアです。公開リレー上の FerrumProxy インスタンスを管理し、config editor で relay 側の limits を扱います。
- `FerrumProxy Client` は `FerrumClient/` にあるユーザーインストール型のアプリ/CLIです。relay の `ip:port` に outbound 接続し、TCP、UDP、または両方、ローカルサービスの port、HAProxy PROXY protocol の有効/無効を選びます。

公開リレーの listener は `0.0.0.0` bind 前提で、公開 share port は一時的に払い出します。Client 側で永続 port を予約する設計にはしません。

現在の設計は [`docs/shared-service-design.md`](docs/shared-service-design.md) を参照してください。

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
