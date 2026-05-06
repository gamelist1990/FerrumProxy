# FerrumProxy Manager API

FerrumProxy Manager API is a separate management plane from the existing `useRestApi` endpoint.
It is intended for FerrumProxyGUI, CLI automation, and external tools that need to manage shared relay tokens without editing `config.yml` directly.

## Start FerrumProxy With Manager API

```bash
FERRUMPROXY_MANAGER_TOKEN="long-random-secret" \
./ferrum-proxy --config config.yml --manager-port 7600
```

Equivalent:

```bash
./ferrum-proxy \
  --config config.yml \
  --manager-port 7600 \
  --manager-token "long-random-secret"
```

The Manager API binds to `127.0.0.1:<manager-port>` only.

`--manager-token` or `FERRUMPROXY_MANAGER_TOKEN` is required when `--manager-port` is used.

## Authentication

Every Manager API request must include:

```http
Authorization: Bearer <manager-token>
```

Missing or invalid authentication returns `401` or `403`.

## FerrumProxyGUI Proxy

FerrumProxyGUI can proxy Manager API requests to the FerrumProxy instance configured with `managerPort` and `managerToken`.

GUI proxy path:

```http
/api/instances/{instanceId}/manager/{managerApiPath}
```

Example:

```http
POST /api/instances/relay-1/manager/api/v1/tokens
```

Automation can call the GUI proxy with:

```http
Authorization: Bearer <manager-token>
```

The GUI uses the instance's saved `managerPort` and `managerToken` to call FerrumProxy locally. The proxied path must start with `api/v1/`.

## Endpoints

### Health

```http
GET /api/v1/health
```

Response:

```json
{
  "ok": true
}
```

### Performance

```http
GET /api/v1/performance
```

Returns the same performance snapshot shape used internally by FerrumProxy metrics.

### Issue Shared Relay Token

```http
POST /api/v1/tokens
Content-Type: application/json
```

Body:

```json
{
  "name": "auto-client",
  "scopes": ["proxy:write"],
  "expiresIn": 2592000,
  "issuerId": "ferrumgui",
  "priority": 10,
  "fixedPort": 41000,
  "limits": {
    "maxBytesPerSecond": 10485760,
    "maxTcpConnections": 32,
    "maxUdpPeers": 64
  }
}
```

Response:

```json
{
  "id": "tok_...",
  "token": "fp_...",
  "expiresAt": "2026-06-05T12:00:00+00:00"
}
```

The raw `token` is returned only once. FerrumProxy stores `tokenHash`, not the raw token.

If `expiresIn` is omitted, the token does not get an expiry timestamp.

Default scopes:

```json
["proxy:write"]
```

### List Shared Relay Tokens

```http
GET /api/v1/tokens
```

Response:

```json
[
  {
    "id": "tok_...",
    "name": "auto-client",
    "scopes": ["proxy:write"],
    "enabled": true,
    "fixedPort": 41000,
    "priority": 10,
    "createdAt": "2026-05-06T12:00:00+00:00",
    "expiresAt": "2026-06-05T12:00:00+00:00",
    "lastUsedAt": null,
    "issuerId": "ferrumgui"
  }
]
```

Raw token values are never returned by list.

### Delete Shared Relay Token

```http
DELETE /api/v1/tokens/{id}
```

Response:

```http
204 No Content
```

For compatibility, `{id}` may also be an existing token name when the token was created before token IDs existed.

## Token Storage

Shared relay tokens support two storage formats:

- Legacy: `token` stores the raw token.
- New: `tokenHash` stores `SHA-256(token + serverSalt)`.

New Manager API issued tokens use the hashed format.

`serverSalt` lives under `sharedService.serverSalt`. If it is empty, the Manager API generates one before issuing the first hashed token.

## cURL Examples Through FerrumProxyGUI

Issue token through GUI:

```bash
curl -X POST "http://<gui-host>:3000/api/instances/<instanceId>/manager/api/v1/tokens" \
  -H "Authorization: Bearer <manager-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "auto-client",
    "scopes": ["proxy:write"],
    "expiresIn": 2592000,
    "priority": 10,
    "fixedPort": 41000,
    "limits": {
      "maxBytesPerSecond": 10485760,
      "maxTcpConnections": 32,
      "maxUdpPeers": 64
    }
  }'
```

List tokens through GUI:

```bash
curl "http://<gui-host>:3000/api/instances/<instanceId>/manager/api/v1/tokens" \
  -H "Authorization: Bearer <manager-token>"
```

Delete token through GUI:

```bash
curl -X DELETE "http://<gui-host>:3000/api/instances/<instanceId>/manager/api/v1/tokens/<tokenId>" \
  -H "Authorization: Bearer <manager-token>"
```
