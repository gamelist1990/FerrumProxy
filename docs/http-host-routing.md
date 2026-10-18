# HTTP hostname routing on a shared port

A listener can serve multiple HTTP hostnames over one TCP port. For HTTPS, TLS must end at FerrumProxy and its certificate must cover every public hostname. Opaque TLS/SNI passthrough routing is not provided by these HTTP mappings.

```yaml
listeners:
  - bind: 0.0.0.0
    tcp: 443
    haproxy: true
    https:
      enabled: true
      letsEncryptDomains: [play.pexserver.com, share.pexserver.com]
      certPath: /etc/letsencrypt/live/play.pexserver.com/fullchain.pem
      keyPath: /etc/letsencrypt/live/play.pexserver.com/privkey.pem
    targets:
      - { host: 100.83.127.8, tcp: 8123 }
    httpMappings:
      - hostname: share.pexserver.com
        path: /
        target: { host: 100.69.76.52, tcp: 8100 }
```

GUI: select the web instance → Settings → Routes → **HTTP Host & Path Mappings**. Add the optional hostname, external path, target host and port. A plain IP target preserves the original HTTP Host; use this for applications that enforce their public origin. URL targets retain the existing Host/path rewrite behavior.

Hostname comparison is exact and case-insensitive; the HTTP Host's port and trailing dot are ignored. Wildcards, schemes and ports are not accepted in the mapping hostname. Host-specific mappings take priority over path-only mappings; within that group the longest path wins. Segment boundaries are respected (`/docs` does not match `/docstring`). The normal target list remains the fallback, preserving existing path-only configurations.

The initial request header is assembled across TCP reads with a 32KiB bound and the existing initial-data timeout. Duplicate Host, folded headers and inconsistent absolute-form request authorities are rejected. Public host routers reject incoming PROXY prefaces; backend PROXY v2 is generated from the accepted client connection, preventing client-IP spoofing at the FileShare trust boundary.

Routing selects the backend once per HTTP/1.1 TCP connection. The connection is then streamed with backpressure, including Range downloads, chunked requests and upgrade traffic. Do not multiplex different users/hosts onto one PROXY connection. Backends must enforce their own authentication, authorization and expected Host; routing is not an authorization boundary. TLS advertises HTTP/1.1 to avoid HTTP/2 origin coalescing across routes.

When adding a hostname, list both the existing and new domains in the GUI's Let's Encrypt domain field and use **Check / Obtain Certificate**. The GUI checks actual SAN coverage and expands an existing certificate when needed. Keep port 80 available for the configured HTTP-01 renewal method. The HTTPS listener checks for renewed certificate/key files every 60 seconds and reloads valid replacements for new connections. Existing sessions continue; a malformed replacement leaves the active certificate in use.
