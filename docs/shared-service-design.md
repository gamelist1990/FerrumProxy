# FerrumProxy Shared Service Design

This document describes the planned "shared service" feature for FerrumProxy and FerrumProxyGUI.

The goal is to provide an OwnServer-like system where a user can temporarily expose a local TCP and/or UDP service through a public FerrumProxy relay server. The public endpoint is temporary and is released when the share stops.

## Goals

- Support TCP, UDP, or both protocols for one share.
- Let the client choose the local service port for TCP and UDP independently.
- Let the client configure the relay server as `host:port`.
- Return a public `ip:port` for other users to connect to.
- Allocate public ports temporarily, not permanently.
- Enforce connection limits, bandwidth limits, structured logs, and idle timeouts.
- Integrate into FerrumProxyGUI as an optional "Shared Service" mode.
- Provide a Tauri + React client experience for desktop use.

## Non-goals for the first version

- Permanent custom port reservation.
- Multi-tenant billing or account management.
- Domain-based routing for arbitrary protocols.
- QUIC-based transport optimization.

## Architecture

```text
Remote user
  |
  | TCP and/or UDP
  v
FerrumProxy relay server
  |
  | authenticated tunnel/control connection
  v
FerrumProxyGUI shared-service client
  |
  | loopback/local network
  v
Local TCP/UDP application
```

The relay server owns the public listener sockets. The client only needs outbound connectivity to the relay server, so it can work behind NAT as long as outbound connections are allowed.

## Share Model

A share represents one local application exposed through the relay.

```yaml
id: generated
name: "My Server"
relay: "relay.example.com:7000"
publicHost: "203.0.113.10"
publicTcpPort: 41025
publicUdpPort: 41025
protocols:
  tcp:
    enabled: true
    localHost: "127.0.0.1"
    localPort: 25565
  udp:
    enabled: true
    localHost: "127.0.0.1"
    localPort: 25565
limits:
  maxTcpConnections: 32
  maxUdpPeers: 64
  maxBytesPerSecond: 10485760
  idleTimeoutSeconds: 120
  udpSessionTimeoutSeconds: 60
haproxy: false
```

TCP and UDP may share the same public port number when the relay can bind both protocols on that port. If either bind fails, the relay may allocate separate TCP and UDP ports and return both values explicitly.

## Relay Server Responsibilities

- Accept authenticated client control connections.
- Create and destroy temporary TCP and UDP public listeners.
- Allocate ports from a configured ephemeral range.
- Reject shares that exceed configured global or per-client limits.
- Forward TCP streams and UDP datagrams through the tunnel transport.
- Track active TCP connections and active UDP peer sessions.
- Enforce bandwidth limits.
- Close idle sessions.
- Emit structured logs and metrics.
- Clean up all sockets and sessions when a client disconnects.

## Client Responsibilities

- Provide a React/Tauri UI for shared-service mode.
- Connect to the configured relay server.
- Register a share with TCP, UDP, or both protocol definitions.
- Connect inbound tunnel sessions to the configured local service.
- Show public endpoints, current status, active sessions, bandwidth usage, and logs.
- Stop the share and release relay resources when requested.

## Control API

The first version should use one authenticated control channel between the client and relay. WebSocket is a practical choice for GUI integration and debugging. A raw TCP framed protocol is also acceptable for lower overhead.

Example control messages:

```json
{ "type": "hello", "clientVersion": "0.1.0", "token": "..." }
{ "type": "createShare", "protocols": { "tcp": { "localPort": 25565 }, "udp": { "localPort": 25565 } } }
{ "type": "shareCreated", "shareId": "...", "publicTcp": "203.0.113.10:41025", "publicUdp": "203.0.113.10:41025" }
{ "type": "stopShare", "shareId": "..." }
{ "type": "stats", "shareId": "...", "activeTcp": 4, "activeUdpPeers": 12, "bytesIn": 1234, "bytesOut": 5678 }
```

## TCP Forwarding

When a remote user connects to the relay's temporary TCP port:

1. Relay checks the share exists and has TCP enabled.
2. Relay checks `maxTcpConnections`.
3. Relay creates a new tunnel stream request to the client.
4. Client connects to `localHost:localPort`.
5. Bytes are copied bidirectionally until EOF, error, bandwidth limit close, or idle timeout.

Each TCP connection is a separate session and should have its own session ID.

## UDP Forwarding

UDP needs session tracking because it is connectionless.

When a remote user sends a datagram to the relay's temporary UDP port:

1. Relay maps the sender address to a UDP peer session.
2. Relay checks `maxUdpPeers`.
3. Relay forwards datagrams to the client with `shareId`, `peerId`, sender address, and payload.
4. Client sends payload to the local UDP service.
5. Client maps local UDP responses back to `peerId`.
6. Relay sends responses back to the original remote UDP sender.

UDP peer sessions expire after `udpSessionTimeoutSeconds` without traffic.

## Limits

Limits should exist at two levels:

- Global relay limits configured by the relay operator.
- Per-share limits requested by the client and capped by the relay.

Recommended initial relay config:

```yaml
sharedService:
  enabled: false
  controlBind: "0.0.0.0:7000"
  publicBind: "0.0.0.0"
  publicHost: "203.0.113.10"
  portRange:
    start: 40000
    end: 49999
  authTokens:
    - "change-me"
  defaults:
    maxTcpConnections: 32
    maxUdpPeers: 64
    maxBytesPerSecond: 10485760
    idleTimeoutSeconds: 120
    udpSessionTimeoutSeconds: 60
  maximums:
    maxTcpConnections: 256
    maxUdpPeers: 512
    maxBytesPerSecond: 104857600
```

### Connection Limits

- TCP: reject or immediately close new inbound TCP connections after `maxTcpConnections`.
- UDP: drop new remote peer sessions after `maxUdpPeers`; existing sessions continue.

### Bandwidth Limits

Use a token bucket per share. The first implementation can apply one shared bucket for all TCP and UDP traffic in both directions. Later versions can split upload/download and TCP/UDP buckets.

When the bucket is exhausted:

- TCP sessions should pause reads briefly or close if throttling remains sustained.
- UDP datagrams should be dropped while logging rate-limited warnings.

### Idle Timeout

TCP sessions close when no bytes are transferred in either direction for `idleTimeoutSeconds`.

UDP peer sessions expire independently after `udpSessionTimeoutSeconds`.

The control channel should also have heartbeat ping/pong. If the client misses heartbeats, the relay must stop all shares owned by that client.

## Logs

Logs should be structured so both the relay and GUI can filter them.

Recommended event types:

- `client.connected`
- `client.disconnected`
- `share.created`
- `share.stopped`
- `share.limit_reached`
- `tcp.accepted`
- `tcp.closed`
- `udp.peer_created`
- `udp.peer_expired`
- `udp.datagram_dropped`
- `bandwidth.throttled`
- `auth.failed`

Each log event should include:

- timestamp
- client ID
- share ID
- protocol
- remote address when applicable
- public endpoint
- bytes in/out when applicable
- close reason when applicable

## GUI Behavior

FerrumProxyGUI should add an option named "Shared Service". When enabled, the main view switches to the sharing UI.

Required controls:

- Relay server `host:port`
- Auth token
- Protocol selector: TCP, UDP, or TCP + UDP
- HAProxy PROXY protocol toggle
- Local TCP port when TCP is enabled
- Local UDP port when UDP is enabled
- Limit fields with relay-capped values
- Start/Stop button
- Public endpoint display
- Copy endpoint buttons
- Live logs
- Active TCP connection count
- Active UDP peer count
- Bandwidth usage

The GUI should clearly show when TCP and UDP have different public ports.

## Tauri Packaging

The Tauri app can reuse the existing React frontend. The tunnel client should run in the Tauri backend rather than pure browser JavaScript because it needs raw TCP/UDP sockets.

Recommended layout:

```text
FerrumGUI/
  frontend/            React UI shared by web GUI and Tauri
  src/                 existing Bun/Express web management server
  src-tauri/           new Tauri desktop shell and tunnel client backend
```

## Implementation Phases

1. Add relay configuration types to FerrumProxy.
2. Add relay control channel and token authentication.
3. Implement TCP share lifecycle and forwarding.
4. Implement UDP share lifecycle and peer mapping.
5. Add limits, logs, heartbeat, and cleanup.
6. Add FerrumProxyGUI API/types for shared-service mode.
7. Add React shared-service UI.
8. Add Tauri shell and move tunnel client socket work into the Tauri backend.
9. Add integration tests for TCP, UDP, limits, idle timeout, and cleanup.

## Key Risks

- UDP behavior is more complex than TCP because source address mapping and timeout cleanup must be correct.
- TCP-over-WebSocket can suffer from head-of-line blocking. It is acceptable for an MVP, but a framed TCP control/data protocol may be better for performance.
- Public relay abuse must be limited with authentication, caps, and logs from the first usable build.
- If TCP and UDP are exposed on the same numeric port, both binds must be handled as one allocation unit to avoid partial allocation leaks.
