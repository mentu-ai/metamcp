# MetaMCP v0.6.0

MetaMCP v0.6.0 brings the gateway onto the MCP 2026-07-28 spec: the stdio
transport now serves both protocol eras on one endpoint, the OAuth client is
hardened to the spec's authorization requirements, and the building blocks for
standards-based inbound authorization ship ready to wire.

## Highlights

- Dual-era stdio surface: modern clients get `server/discover`, per-request
  `_meta` validation (`-32021`/`-32022`), and `resultType`/`serverInfo`/cache-hint
  result envelopes; legacy `initialize` clients are untouched.
- OAuth client hardening: CSRF `state`, RFC 9207 issuer validation with
  first-use pinning, and additive step-up scope handling.
- OS-assigned OAuth callback port replaces fixed 19890 — concurrent
  authorizations no longer collide, and the listener never outlives the flow.
- Client ID Metadata Document (`oauthClientMetadataUrl`) and `oauthScope`
  config, with Dynamic Client Registration as the fallback.
- Child-server era probing with per-server caching — see which children
  already speak MCP 2026-07-28.
- RFC 9728 / RFC 8707 inbound-authorization core (protected-resource metadata,
  bearer challenges, audience validation), shipped inert for the HTTP gateway
  to adopt.
- SDK-internal `_process` access is now guarded and shape-tested, so an SDK
  upgrade fails loudly instead of silently degrading graceful shutdown.

## Validation

- `npm ci`
- `npm run build`
- `npm run typecheck`
- `npm test`
- `scripts/smoke-test.sh`
- `npm pack --dry-run`
