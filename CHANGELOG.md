# Changelog

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
