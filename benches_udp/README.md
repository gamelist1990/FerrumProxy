# FerrumProxy ベンチマーク

Python 標準ライブラリだけで動く UDP + TCP ベンチマーク一式です。
**Windows / Ubuntu (Linux) / macOS** で同じスクリプトが使えます。

## 前提

- `python3` (Windows なら `python.exe`) が PATH にある
- FerrumProxy を release build 済み (無ければ自動で `cargo build --release`)
- 追加 pip パッケージ不要

## 実行

```bash
cd benches_udp

# 基本 (UDP + TCP を 1000 メッセージずつ、512 バイト payload)
python3 run_bench.py --count 1000 --size 512

# PROXY v2 header 有効 (Geyser のような setup を再現)
python3 run_bench.py --count 1000 --haproxy

# UDP だけ / TCP だけ
python3 run_bench.py --skip-tcp
python3 run_bench.py --skip-udp
```

Windows の PowerShell でも同じコマンドで動きます (`python3` の代わりに
`python` を使ってください)。

## 何をやるか

1. `echo_server.py` を UDP:40000 と TCP:40010 で起動 (backend 役)
2. **baseline**: client → 直接 echo (proxy 経由なし)
3. FerrumProxy を UDP:40001→40000 / TCP:40011→40010 で起動
4. **proxied**: client → proxy → echo
5. 差分を計測して mean / P50 / P90 / P99 / max / total を表示

## 出力例

```
=== UDP (1000 messages, 512 bytes) ===
metric      baseline     proxied    delta_ms     ratio
----------  ----------  ----------  ----------  --------
mean_ms       0.1170      0.1330    +0.0160      1.14
p50_ms        0.0880      0.0980    +0.0100      1.11
p99_ms        0.2450      0.2120    -0.0330      0.87
```

## ファイル

| ファイル | 役割 |
|---|---|
| `echo_server.py` | UDP+TCP echo server (backend) |
| `bench_client.py` | 遅延計測クライアント (JSON 出力) |
| `run_bench.py` | 全体をつなぐハーネス |
| `bench-config.yml` | 実行時に自動生成される proxy 設定 (削除 OK) |
| `logs/` | proxy と echo の stdout/stderr |
