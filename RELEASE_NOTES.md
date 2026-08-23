# MetaMCP v1.0.0

MetaMCP 1.0 draws a clearer boundary: keep important, frequently used, compact,
or security-sensitive MCP servers connected directly, and place the irregular
long tail behind three stable tools. Repeated multi-server workflows can become
reviewed declarative Methods instead of model-authored JavaScript.

This is a breaking release. Read the
[migration guide](https://github.com/mentu-ai/metamcp/blob/v1.0.0/docs/MIGRATION-1.0.md)
before upgrading from 0.x.

## Highlights

- **Three explicit tools.** `mcp_discover` searches static or cached
  capabilities, `mcp_call` invokes one named child lazily, and `mcp_run`
  executes a reviewed Method.
- **Declarative Method Mode.** JSON manifests define bounded steps, deadlines,
  effects, schemas, interpolation, safe retries, polling, typed gaps, and trace
  output. Write and mixed Methods require an operator opt-in.
- **No arbitrary execution surface.** `mcp_execute`, its Node.js VM, model-facing
  package provisioning, and model-facing skill advice are gone. There is no
  compatibility switch that restores them.
- **Safer failure semantics.** Child calls are serialized per server and never
  replayed automatically after a timeout, crash, or transport failure. A Method
  may retry only a step that explicitly declares safe idempotency.
- **Tighter secrets and networking.** Child processes receive a minimal
  environment, unresolved secret references fail closed, semantic search is
  local unless explicitly enabled, HTTP binds to loopback by default, and
  non-loopback exposure requires authentication.
- **Inspect before installing.** `metamcp tools [--json]` reads the exact runtime
  definitions and exits before loading configuration, storage, children, or a
  transport.
- **Executable publication contract.** Package, lockfile, release notes,
  changelog, tool surface, and official MCP Registry metadata must agree before
  npm will publish.

## Choosing the right path

| Path | Use it for |
|---|---|
| Direct MCP | Foundational, high-frequency, compact, or high-consequence servers |
| `mcp_discover` + `mcp_call` | Irregular long-tail capabilities |
| `mcp_run` | Repeated, reviewed Acquire → Normalize → Analyze workflows |

MetaMCP is a lifecycle and policy boundary, not an OS sandbox for untrusted MCP
packages. Review child commands and credentials exactly as you would for a
direct connection.

## Validation

- TypeScript strict typecheck
- Full unit, protocol, security, and E2E suite
- 23-check stdio and Streamable HTTP smoke test
- Clean production install from the generated npm tarball
- `npm audit --omit=dev`
- Official `mcp-publisher validate server.json`
