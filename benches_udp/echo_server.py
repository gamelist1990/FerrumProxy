#!/usr/bin/env python3
"""
UDP + TCP echo server for FerrumProxy benchmarks.

Listens on the given UDP port and/or TCP port and echoes back every payload it
receives. Pure stdlib -- runs on Windows / Linux / macOS with just `python3`.
"""
import argparse
import socket
import sys
import threading


def run_udp(port: int) -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    print(f"[echo] UDP listening on 0.0.0.0:{port}", flush=True)
    while True:
        try:
            data, addr = srv.recvfrom(65535)
            srv.sendto(data, addr)
        except OSError as e:
            print(f"[echo] UDP error: {e}", file=sys.stderr, flush=True)
            return


def _tcp_client(conn: socket.socket, addr) -> None:
    with conn:
        while True:
            try:
                data = conn.recv(65535)
            except OSError:
                return
            if not data:
                return
            try:
                conn.sendall(data)
            except OSError:
                return


def run_tcp(port: int) -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(64)
    print(f"[echo] TCP listening on 0.0.0.0:{port}", flush=True)
    while True:
        conn, addr = srv.accept()
        # Disable Nagle: bench packets are small and back-to-back, we want
        # every send to hit the wire immediately (mirrors what a real game
        # server would do).
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        threading.Thread(target=_tcp_client, args=(conn, addr), daemon=True).start()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--udp-port", type=int, default=40000)
    p.add_argument("--tcp-port", type=int, default=40010)
    p.add_argument("--no-udp", action="store_true")
    p.add_argument("--no-tcp", action="store_true")
    args = p.parse_args()

    threads = []
    if not args.no_udp:
        t = threading.Thread(target=run_udp, args=(args.udp_port,), daemon=True)
        t.start()
        threads.append(t)
    if not args.no_tcp:
        t = threading.Thread(target=run_tcp, args=(args.tcp_port,), daemon=True)
        t.start()
        threads.append(t)

    if not threads:
        print("nothing to do (both protocols disabled)", file=sys.stderr)
        return 2

    try:
        # Sleep forever; threads are daemons so Ctrl+C exits cleanly.
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        print("[echo] shutting down", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
