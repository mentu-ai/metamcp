# MetaMCP v0.7.0

MetaMCP v0.7.0 completes the MCP 2026-07-28 work in both directions. v0.6.0 made
the gateway *serve* both protocol eras; this release makes it *speak* the modern
era to the child servers that support it, and replaces the HTTP gateway's shared
secret with standards-based authorization.

## Highlights

- **Modern-era outbound.** Child servers are probed with `server/discover`
  before any handshake — an `initialize` would commit the connection to the
  legacy era — and those that support MCP 2026-07-28 are driven statelessly,
  with per-request `_meta` and no handshake at all. Children that do not support
  it follow exactly the path they did before.
- **RFC 9728 protected-resource metadata.** Served at its well-known path so a
  client with no token can discover where to authenticate.
- **RFC 8707 audience validation.** JWT bearer tokens are signature-verified
  against the authorization server's JWKS and checked to have been minted for
  *this* resource, so a token issued for another service cannot be replayed here.
- **`WWW-Authenticate` challenges** carrying the metadata URL and, on an
  insufficient-scope rejection, the scopes actually needed.
- **The shared-secret mode still works**, and its comparison is now
  constant-time. It remains the simplest option for a private deployment.

## Configuring gateway authorization

Three exclusive modes, resolved from the environment at startup:

| Mode | Set | Behaviour |
|---|---|---|
| oauth | `METAMCP_RESOURCE_URL` + `METAMCP_AUTH_ISSUER` | JWKS-verified, audience-validated bearer tokens; metadata document served |
| static-token | `METAMCP_HTTP_BEARER_TOKEN` | Shared secret, compared in constant time |
| open | neither | Unauthenticated, with a startup warning |

Optional in oauth mode: `METAMCP_AUTH_JWKS_URI` (defaults to the issuer's
conventional JWKS path), `METAMCP_AUTH_REQUIRED_SCOPES`,
`METAMCP_AUTH_SUPPORTED_SCOPES`.

The modes are deliberately not combinable — accepting a shared secret *or* a
verified token would let the weaker credential define the endpoint's security —
and a half-configured OAuth setup is refused at startup rather than silently
downgraded.

## Validation

- `npm ci`
- `npm run build`
- `npm run typecheck`
- `npm test`
- `scripts/smoke-test.sh`
- `npm pack --dry-run`
