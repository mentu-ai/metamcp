# MetaMCP v0.5.0

MetaMCP v0.5.0 adds the production GCP path: deploy MetaMCP as a Streamable HTTP MCP gateway on Cloud Run, register it with Google Agent Registry, consume it from Google ADK agents, and export hash-linked evidence for tool calls.

## Highlights

- Streamable HTTP server mode for Cloud Run with `/mcp` and `/healthz`.
- Secret Manager, IAM, Cloud Build, Docker, Azure DevOps, and Agent Registry artifacts.
- Python ADK sample using `AgentRegistry.get_mcp_toolset`.
- Evidence export from `.metamcp/ledger.jsonl` to a verifiable hash-linked bundle.
- Airtable MCP and Cotizera-style prompt regression fixtures.
- Sandbox timeout hardening for infinite loops and promise microtasks.
- CI coverage for HTTP transport, gateway auth, evidence export, and sandbox behavior.

## Validation

- `npm ci`
- `npm run build`
- `npm run typecheck`
- `npm test`
- `scripts/smoke-test.sh`
- `docker build -t metamcp:v0.5.0-smoke .`
- `npm pack --dry-run`
