# FerrumProxy Client

FerrumProxy Client is the user-installed app for shared-service mode. It is separate from `FerrumGUI`, which is only for managing the relay server.

The client connects outbound to a FerrumProxy relay `ip:port`, then bridges the relay to a local TCP and/or UDP service.

## GUI

```bash
bun install
cd frontend && bun install && cd ..
bun run tauri:build
```

## CLI

```bash
bun run cli -- --relay 203.0.113.10:7000 --protocol both --tcp-port 25565 --udp-port 25565 --haproxy
```

Options:

- `--relay <ip:port>`: FerrumProxy relay control endpoint
- `--protocol <tcp|udp|both>`: protocol mode
- `--tcp-port <port>`: local TCP service port
- `--udp-port <port>`: local UDP service port
- `--haproxy`: enable HAProxy PROXY protocol for the local service
