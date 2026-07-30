# Changelog

## v0.6.0

Released 2026-07-29.

- Added dual-era protocol support (MCP 2026-07-28) on the stdio transport: `server/discover`, per-request `_meta` validation with the new `-32021`/`-32022` error codes, and `resultType`/`serverInfo`/cache-hint result envelopes for modern clients, while legacy `initialize` clients pass through unchanged.
- Added OAuth client hardening: CSRF `state` (previously never sent), RFC 9207 issuer validation with first-use pinning, and step-up scope handling for `insufficient_scope` challenges.
- Replaced the fixed OAuth callback port 19890 with an OS-assigned loopback port, so concurrent authorizations no longer collide; the listener is released on failed and token-cached connects.
- Added Client ID Metadata Document support (`oauthClientMetadataUrl`) and per-server `oauthScope` config; Dynamic Client Registration remains the fallback.
- Added child-server era probing with per-server caching, reporting which children already speak MCP 2026-07-28.
- Added an RFC 9728 / RFC 8707 inbound-authorization core (protected-resource metadata, bearer challenges, audience validation) as an inert module; the HTTP gateway still uses the existing bearer-token check.
- Guarded the SDK-internal `_process` access behind `resolveChildProcess()` with a shape-guard test, so an SDK rename fails the suite instead of silently degrading graceful shutdown.
- Smoke test now derives the expected version and protocol version instead of hardcoding them.

## v0.5.0

Released 2026-06-04.

- Added Streamable HTTP mode for deploying MetaMCP as a remote MCP gateway on Cloud Run.
- Added `/healthz`, `METAMCP_TRANSPORT`, `METAMCP_CONFIG`, `METAMCP_HTTP_PATH`, and gateway bearer auth.
- Added Docker, Cloud Build, Azure DevOps, Secret Manager, IAM, and Agent Registry registration examples.
- Added a Google ADK sample agent that resolves MetaMCP through `AgentRegistry.get_mcp_toolset`.
- Added hash-linked evidence bundle export from `.metamcp/ledger.jsonl`.
- Added prompt regression fixtures for Airtable MCP and Cotizera-style agent workflows.
- Hardened sandbox timeouts for synchronous loops and promise microtasks.
- Added HTTP transport, auth, evidence export, and sandbox regression tests.
