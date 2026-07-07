#!/usr/bin/env python3
"""
Bench client for FerrumProxy.

Sends N packets/messages to a target host:port, times each round trip with a
perf_counter, and prints Mean / P50 / P90 / P99 / Max / TotalMs / Loss as
JSON so the harness can parse it.

Protocol:
  * `udp`  -- one datagram per iteration, timeout on missed reply.
  * `tcp`  -- one long-lived connection; each iteration sends `size` bytes
              and waits for `size` bytes back. TCP_NODELAY is set so small
              messages hit the wire immediately.
"""
import argparse
import json
import math
import os
import socket
import sys
import time


def ns() -> int:
    return time.perf_counter_ns()


def percentile(sorted_us, p: float) -> float:
    if not sorted_us:
        return 0.0
    idx = int(math.floor((len(sorted_us) - 1) * p))
    return sorted_us[idx]


def bench_udp(host: str, port: int, count: int, size: int, timeout_ms: int):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout_ms / 1000.0)
    sock.bind(("", 0))
    payload = os.urandom(size)

    # Warm-up: 3 packets to prime the kernel routing / socket table.
    for _ in range(3):
        try:
            sock.sendto(payload, (host, port))
            sock.recvfrom(65535)
        except OSError:
            pass

    latencies_us = []
    lost = 0
    total_start = ns()
    for _ in range(count):
        t0 = ns()
        try:
            sock.sendto(payload, (host, port))
            sock.recvfrom(65535)
            latencies_us.append((ns() - t0) / 1000.0)
        except socket.timeout:
            lost += 1
    total_ms = (ns() - total_start) / 1_000_000.0
    sock.close()
    return latencies_us, lost, total_ms


def bench_tcp(host: str, port: int, count: int, size: int, timeout_ms: int):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout_ms / 1000.0)
    sock.connect((host, port))
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    payload = os.urandom(size)

    def recv_exact(n: int) -> None:
        remaining = n
        while remaining > 0:
            chunk = sock.recv(remaining)
            if not chunk:
                raise ConnectionError("peer closed")
            remaining -= len(chunk)

    # Warm-up: 3 messages.
    for _ in range(3):
        sock.sendall(payload)
        recv_exact(len(payload))

    latencies_us = []
    lost = 0
    total_start = ns()
    for _ in range(count):
        t0 = ns()
        try:
            sock.sendall(payload)
            recv_exact(len(payload))
            latencies_us.append((ns() - t0) / 1000.0)
        except (socket.timeout, ConnectionError, OSError):
            lost += 1
            break  # TCP failure is terminal; don't try more
    total_ms = (ns() - total_start) / 1_000_000.0
    try:
        sock.close()
    except OSError:
        pass
    return latencies_us, lost, total_ms


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--protocol", choices=["udp", "tcp"], required=True)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--count", type=int, default=1000)
    p.add_argument("--size", type=int, default=512)
    p.add_argument("--timeout-ms", type=int, default=2000)
    p.add_argument("--label", default="")
    args = p.parse_args()

    if args.protocol == "udp":
        lat, lost, total_ms = bench_udp(
            args.host, args.port, args.count, args.size, args.timeout_ms
        )
    else:
        lat, lost, total_ms = bench_tcp(
            args.host, args.port, args.count, args.size, args.timeout_ms
        )

    if not lat:
        result = {
            "label": args.label,
            "protocol": args.protocol,
            "target": f"{args.host}:{args.port}",
            "count": args.count,
            "lost": lost,
            "error": "all messages lost",
        }
        print(json.dumps(result))
        return 1

    lat.sort()
    result = {
        "label": args.label,
        "protocol": args.protocol,
        "target": f"{args.host}:{args.port}",
        "count": args.count,
        "delivered": len(lat),
        "lost": lost,
        "size": args.size,
        "total_ms": round(total_ms, 3),
        "mean_ms": round(sum(lat) / len(lat) / 1000.0, 4),
        "p50_ms": round(percentile(lat, 0.50) / 1000.0, 4),
        "p90_ms": round(percentile(lat, 0.90) / 1000.0, 4),
        "p99_ms": round(percentile(lat, 0.99) / 1000.0, 4),
        "max_ms": round(lat[-1] / 1000.0, 4),
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
