# Changelog

## v1.0.0

Released 2026-08-22.

- Redefined MetaMCP as an on-demand gateway for long-tail MCP servers rather than a universal replacement for direct MCP connections.
- Reduced the model-facing surface to `mcp_discover`, `mcp_call`, and `mcp_run`.
- Added declarative Method Mode with JSON Schema input/output validation, bounded sequential steps, safe interpolation, typed gaps, traces, explicit effects, safe retry, and bounded polling.
- Removed `mcp_execute` and its Node.js VM implementation. There is no unsafe compatibility flag.
- Removed model-facing package provisioning and skill-advice tools; gallery installation remains an explicit CLI action.
- Made discovery static/cached by default. Live schema refresh requires one explicit server and never fans out implicitly.
- Added single-flight child connection startup and serialized per-child calls.
- Removed automatic call replay after timeouts, crashes, and transport failures.
- Replaced ambient environment inheritance with a minimal allowlist plus per-child `inheritEnv` and explicit `env` values.
- Replaced the Mentu-specific shell vault lookup with a generic `SecretProvider` boundary; unresolved references now fail closed.
- Made discovery local and keyword-only by default; Voyage search and the optional SQLite index now require explicit `METAMCP_VOYAGE_API_KEY` opt-in and load lazily.
- Changed HTTP's default bind to `127.0.0.1`, refused unauthenticated non-loopback binds, and added exact Origin allowlisting.
- Extended dual-era handling to the Streamable HTTP request transport.
- Made `metamcp init` preview-only by default, targetable by client, atomic on apply, and fail-closed on malformed JSON.
- Made ledger appends ordered and awaited before returning a completed gateway call.
- Added unit and end-to-end coverage for Method manifests, typed gaps, retry/poll bounds, write policy, lazy spawn, concurrent startup, uncertain mutation delivery, init safety, HTTP Origin checks, and bind posture.
- Added a side-effect-free `metamcp tools [--json]` inspector backed by the same definitions served over MCP.
- Added version-synchronized MCP Registry metadata and an executable pre-publish release contract.

## v0.7.0

Released 2026-07-30.

- Added modern-era (MCP 2026-07-28) outbound calls to child servers. MetaMCP now probes `server/discover` before any handshake and drives children that support it with per-request `_meta` and no `initialize`; children that do not are unaffected and follow exactly the path they did before.
- Added standards-based inbound authorization for the Streamable HTTP gateway: RFC 9728 protected-resource metadata served at its well-known path, RFC 8707 audience-validated JWT bearer tokens verified against the authorization server's JWKS, and `WWW-Authenticate` challenges that carry the metadata URL and any required scopes. Configure with `METAMCP_RESOURCE_URL` and `METAMCP_AUTH_ISSUER` (plus optional `METAMCP_AUTH_JWKS_URI`, `METAMCP_AUTH_REQUIRED_SCOPES`, `METAMCP_AUTH_SUPPORTED_SCOPES`).
- Made the existing `METAMCP_HTTP_BEARER_TOKEN` comparison constant-time. That mode still works unchanged and remains the simplest option for a private deployment.
- JWT signature verification pins algorithms server-side and refuses symmetric algorithms, since a JWKS key is public. `jose` is now a declared dependency.
- Fixed: a successful OAuth connect using cached tokens left its loopback redirect listener open for the lifetime of the process.

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
