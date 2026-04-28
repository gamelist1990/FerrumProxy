# FerrumProxy Shared Service Design

This document defines the split between the public relay server and the user-installed client.

## Roles

- FerrumProxy runs on the public relay server. It owns temporary public TCP/UDP ports and binds public listeners on `0.0.0.0`.
- FerrumProxyGUI runs on the relay server as the management app. It manages relay configuration and limits only.
- FerrumProxy Client runs on a user's machine. It connects outbound to the relay `ip:port` and bridges relay sessions to the user's local TCP/UDP service.

This separation matters: FerrumProxyGUI must not ask for a user's local service port. Local ports, protocol selection, and HAProxy PROXY protocol are client-side options.

## Relay Server Settings

FerrumProxyGUI should expose only relay-side controls:

- shared service enabled/disabled
- max TCP connections
- max UDP peers
- max bytes per second
- TCP idle timeout seconds
- UDP session timeout seconds

The relay's public bind is fixed to `0.0.0.0`. Public share ports are allocated temporarily by the relay and released when the share stops.

Example FerrumProxy config shape:

```yaml
sharedService:
  enabled: true
  controlBind: 0.0.0.0:7000
  publicBind: 0.0.0.0
  portRange:
    start: 40000
    end: 49999
  defaults:
    maxTcpConnections: 32
    maxUdpPeers: 64
    maxBytesPerSecond: 10485760
    idleTimeoutSeconds: 120
    udpSessionTimeoutSeconds: 60
```

`controlBind` is the relay `ip:port` that users enter in FerrumProxy Client.

## Client Settings

FerrumProxy Client should expose:

- relay address: `ip:port`
- auth token when configured
- protocol: TCP, UDP, or TCP + UDP
- local TCP service port when TCP is enabled
- local UDP service port when UDP is enabled
- HAProxy PROXY protocol enabled/disabled

Client examples:

```bash
ferrumproxy-client --relay 203.0.113.10:7000 --protocol tcp --tcp-port 25565
ferrumproxy-client --relay 203.0.113.10:7000 --protocol both --tcp-port 25565 --udp-port 25565 --haproxy
```

## Connection Flow

```text
Remote user
  |
  | connects to temporary public ip:port
  v
FerrumProxy relay server
  |
  | tunnel session over outbound client connection
  v
FerrumProxy Client on user's machine
  |
  | 127.0.0.1:localPort or configured local service
  v
User's local TCP/UDP application
```

## TCP

1. Client connects to the relay control endpoint.
2. Client requests TCP sharing for a local TCP port.
3. Relay allocates a temporary public TCP port.
4. Remote users connect to the public `ip:port`.
5. Relay forwards the stream through the client tunnel.
6. Client connects to the local TCP service.
7. If HAProxy is enabled, the client/tunnel sends a PROXY protocol v2 header to the local service.

## UDP

1. Client requests UDP sharing for a local UDP port.
2. Relay allocates a temporary public UDP port.
3. Relay maps each remote sender to a UDP peer session.
4. Relay forwards datagrams through the client tunnel.
5. Client sends datagrams to the local UDP service and maps responses back to the relay peer.
6. UDP peer sessions expire after `udpSessionTimeoutSeconds`.

## Limits And Logs

Limits are enforced by the relay server, not trusted from the client.

Required relay events:

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

## Implementation Phases

1. Keep FerrumProxyGUI focused on relay config and limits.
2. Keep FerrumProxy Client as a separate Tauri GUI and CLI entrypoint.
3. Implement relay control authentication and share registration in FerrumProxy.
4. Implement client tunnel transport for TCP and UDP.
5. Wire public temporary port allocation to relay sessions.
6. Add integration tests for TCP, UDP, HAProxy on/off, limits, idle timeout, and cleanup.
