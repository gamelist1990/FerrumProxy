# FerrumProxy Client

FerrumProxy Client is the user-installed app for shared-service mode. It is separate from `FerrumGUI`, which is only for managing the relay server.

The client connects outbound to a FerrumProxy relay `host:port`, then bridges the relay to a local TCP and/or UDP service.

## GUI

```bash
bun install
cd frontend && bun install && cd ..
bun run tauri:build
```

## CLI

The CLI uses the same FerrumProxy shared-relay protocol as the GUI client, including relay API validation, optional token validation, TCP/UDP tunnel registration, and HAProxy mode.

Run it from source:

```bash
bun run cli -- --relay 203.0.113.10:7000 --protocol both --tcp-port 25565 --udp-port 25565 --haproxy
```

Or build a standalone executable that does not require Bun on the target machine:

```bash
bun run cli:build
```

Release builds publish standalone CLI executables for Linux x64, Windows x64, and macOS arm64 alongside the GUI installers.

### Options

- `--relay <host:port>`: relay control endpoint. Defaults to `FERRUMPROXY_RELAY`, then `127.0.0.1:7000`.
- `--token <token>`: relay authentication token. Defaults to `FERRUMPROXY_TOKEN` when set.
- `--protocol <tcp|udp|both>`: protocol mode. Default: `tcp`.
- `--local-host <host>`: local service host. Default: `127.0.0.1`.
- `--tcp-port <port>`: local TCP service port. Default: `25565`.
- `--udp-port <port>`: local UDP service port. Default: `25565`.
- `--haproxy`: request HAProxy PROXY protocol handling for relay tunnels.
- `--no-status`: disable the live terminal status line.
- `-h`, `--help`: show CLI help.

Examples:

```bash
# TCP only
ferrumproxy-client-cli --relay relay.example.com:7000 --tcp-port 25565

# UDP only
ferrumproxy-client-cli --relay relay.example.com:7000 --protocol udp --udp-port 19132

# TCP + UDP with authentication and HAProxy mode
ferrumproxy-client-cli --relay relay.example.com:7000 --token YOUR_TOKEN --protocol both --haproxy
```
