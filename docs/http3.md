# HTTP/3 frontend

Set `https.http3: true` on an HTTPS TCP listener with explicit hostname routes. FerrumProxy binds QUIC on UDP at the same port; retain TCP for ordinary HTTPS, wget, and WebSocket uploads. GUI exposes the same HTTP/3 switch. A generic UDP relay cannot share this UDP socket. Allow the UDP port through both the host firewall and cloud security list before advertising HTTP/3 with Alt-Svc at the origin.

QUIC uses Quinn and h3 with TLS 1.3 and the existing renewed certificate. 0-RTT and connection migration are disabled to avoid replaying mutations or changing the IP used for registration/rate controls. Retry validates source addresses before TLS allocation. Existing IP blocks and connection admission limits apply. There are at most 256 concurrent QUIC connections, 512 forwarding streams globally and 16 per connection; QUIC receive windows and the two-frame forwarding queue bound buffering. Headers are limited to 16KB. Reads and writes have timeouts.

Each stream independently routes its authority and path, opens its own HTTP/1.1 origin connection, and streams both request and response with backpressure. Hop-by-hop headers are removed; cookies, Range, compression and request bodies are retained. When haproxy is enabled, a TCP PROXY v2 preface contains the validated QUIC peer identity. Unknown hostnames and CONNECT receive 421. Only explicit configured host routes are forwarded. This frontend currently targets plain HTTP origins (including the private Tailscale A8 origin); HTTPS origins and mounted URL rewriting are not supported. The browser-to-edge leg is QUIC; the origin leg remains TCP. HTTP/3 does not remove loss on the origin leg or exceed physical bandwidth.

The integration test establishes real QUIC with validated local TLS, verifies PROXY v2 identity, streaming uploads with and without Content-Length, Range and multiple cookies, rejects unknown authority, and demonstrates that a delayed stream does not block another stream. TCP remains handled by the existing listener and is unaffected when HTTP/3 is disabled.

## Deployment probe

Run `cargo run --example http3-probe -- https://share.pexserver.com/healthz 132.145.118.98` from outside the edge host. The optional address selects the destination while retaining the URL hostname for certificate validation. The probe uses system trust roots, bounded timeouts, a Range request and a bounded response body. It never disables certificate verification.

On 2026-10-19 the production web instance was upgraded through the GUI to core `2026.10.19-69dbb36`, and its HTTP/3 checkbox was enabled, saved and applied by restarting only web. UDP443 is listening and its host firewall allowance is persisted. Real HTTP/3 through Tailscale returned certificate-verified 200 for healthz and 206 with 1024 bytes for a public file. Existing TCP HTTPS for share and play, plus wget Range downloads, passed.

Public-IP QUIC probes from two separate hosts currently time out; a simultaneous capture on the public interface saw no arriving UDP443 packets. Cloud security-list/NSG ingress must be checked before enabling origin Alt-Svc advertisements. FileShare keeps `http3Port: 0` until public certificate-verified QUIC succeeds. A working Tailscale probe alone is not proof of public reachability.
