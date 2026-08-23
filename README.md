# MetaMCP

[![npm version](https://img.shields.io/npm/v/@mentu/metamcp)](https://www.npmjs.com/package/@mentu/metamcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![CI](https://github.com/mentu-ai/metamcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mentu-ai/metamcp/actions/workflows/ci.yml)

MetaMCP is a secure, on-demand gateway for the long tail of MCP servers. It gives an MCP client three stable tools:

- `mcp_discover` finds configured servers, cached tool schemas, and reviewed Methods without starting every child.
- `mcp_call` lazily calls one explicitly named child tool.
- `mcp_run` executes a bounded, schema-validated declarative Method.

MetaMCP is deliberately not a replacement for every direct MCP connection. Keep important, frequently used, compact, or strongly authenticated MCPs direct. Put irregular long-tail servers behind MetaMCP, and promote repeated multi-step rituals into Methods.

```text
                               ┌─ direct: GitHub / Codex Apps / core runtime
MCP client ────────────────────┤
                               └─ MetaMCP (3 tools)
                                    ├─ discover cached capabilities
                                    ├─ call one lazy child
                                    └─ run reviewed Methods
```

## When to use which path

| Path | Best fit | Why |
|---|---|---|
| Direct MCP | High-frequency, compact, security-sensitive, or foundational servers | Preserves typed schemas, native auth, and explicit approvals |
| `mcp_discover` + `mcp_call` | Long-tail or irregular capabilities | Keeps the client surface small without hiding the assembly language |
| `mcp_run` | Repeated Acquire → Normalize → Analyze workflows | Makes bounded behavior testable, versioned, and evidence-producing |

Do not route billing, infrastructure mutation, identity, or another high-consequence server through MetaMCP merely to reduce tool count. The right boundary is operational, not ideological.

## Quick start

Requires Node.js 20 or newer.

```bash
npx @mentu/metamcp@latest --config .mcp.json
```

Create `.mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem@2026.7.10", "/path/to/allowed/files"]
    },
    "internal-api": {
      "command": "node",
      "args": ["./servers/internal-api.js"],
      "env": { "API_TOKEN": "${INTERNAL_API_TOKEN}" },
      "inheritEnv": ["HTTP_PROXY"]
    }
  }
}
```

Child servers start only when explicitly refreshed, called, or used by a Method. Plain discovery reads configuration and cached schemas; it does not spawn all children.

Server names are stable cache identities and must contain 1-128 letters, numbers, dots, underscores, or hyphens; path separators and traversal-like names are rejected.

### Safe client setup

`init` is preview-only unless `--yes` is supplied. Without a named client it considers existing client config files only.

```bash
metamcp init                         # preview, no writes
metamcp init --client Codex          # preview one client
metamcp init --client Codex --yes    # apply atomically and write a .bak
```

Malformed JSON is rejected and left untouched. A named client may be created explicitly; MetaMCP never creates every supported client config by default.

## The three tools

### Discover

```json
{ "query": "capture screenshot", "kind": "tool" }
```

Discovery searches only live or cached schemas. To refresh one server from its live tool list:

```json
{ "server": "browser", "refresh": true }
```

`refresh` without a server is rejected so an agent cannot accidentally fan out across the whole configuration.

### Call

```json
{
  "server": "browser",
  "tool": "capture_page",
  "args": { "url": "https://example.com" },
  "timeoutMs": 60000
}
```

MetaMCP never automatically replays a child call after a timeout or transport failure. The child may have completed a mutation before the response was lost. A later Method may retry only when its manifest explicitly declares that step `idempotency: "safe"`.

### Run a Method

Put JSON manifests in `.metamcp/methods/` or pass `--methods <directory>`. The child server and tool names below are illustrative; bind them to reviewed servers in your own config:

```json
{
  "apiVersion": "metamcp.io/v1alpha1",
  "kind": "Method",
  "metadata": {
    "name": "content.acquire-and-normalize",
    "version": "1.0.0",
    "description": "Acquire content and normalize it into a stable record"
  },
  "spec": {
    "effects": "read",
    "inputSchema": {
      "type": "object",
      "properties": { "url": { "type": "string" } },
      "required": ["url"],
      "additionalProperties": false
    },
    "steps": [
      {
        "id": "acquire",
        "server": "fetch",
        "tool": "fetch",
        "args": { "url": "${input.url}" }
      },
      {
        "id": "normalize",
        "server": "content",
        "tool": "normalize",
        "dependsOn": ["acquire"],
        "args": { "document": "${steps.acquire.structuredContent}" }
      }
    ],
    "output": "${steps.normalize.structuredContent}"
  }
}
```

Then call:

```json
{ "method": "content.acquire-and-normalize", "input": { "url": "https://example.com" } }
```

Methods are declarative rather than arbitrary JavaScript. They have bounded step counts, deadlines and output sizes; input/output JSON Schemas; explicit read/write effects; safe interpolation; typed gaps; and a per-step trace. Write or mixed-effect Methods are disabled unless the gateway operator starts MetaMCP with `--allow-writes`.

See [Method Mode](docs/METHOD-MODE.md), the [manifest schema](schemas/method-v1alpha1.schema.json), and the [example Method](examples/methods/content.acquire-and-normalize.method.json). The design generalizes the consistency layer documented by [Crawlio Method Mode](https://docs.crawlio.app/mcp/method-mode?utm_source=github&utm_medium=docs&utm_campaign=mcp-setup&utm_content=metamcp-method-mode&utm_term=method-mode).

## Configuration and secrets

`${NAME}` references in `env` and HTTP `headers` resolve from the host environment by default. An unresolved reference fails startup; it is never passed to a child as a literal placeholder.

MetaMCP does not copy its ambient environment into stdio children. It inherits only a small runtime allowlist (`PATH`, home/temp/locale variables, and platform equivalents), variables named in `inheritEnv`, and values explicitly set in the child `env` block. Embedders can install a custom `SecretProvider` for a keychain or vault.

Discovery is local keyword search by default. To opt into Voyage-backed semantic search, set `METAMCP_VOYAGE_API_KEY` explicitly; discovery queries will then be sent to Voyage and the optional local SQLite vector index will be enabled. Ambient `ANTHROPIC_API_KEY` or `VOYAGE_API_KEY` variables never activate network calls.

Remote child servers use `url`, `transportType`, `headers`, and the existing OAuth fields:

```json
{
  "mcpServers": {
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "transportType": "http",
      "headers": { "Authorization": "Bearer ${REMOTE_TOKEN}" }
    }
  }
}
```

## HTTP gateway

HTTP mode binds to `127.0.0.1` by default:

```bash
metamcp --transport http --port 8080 --config .mcp.json
```

An unauthenticated non-loopback bind fails closed. Configure OAuth resource-server validation or `METAMCP_HTTP_BEARER_TOKEN` before exposing the listener. Browser requests with an `Origin` header are denied unless the exact origin is supplied with `--allow-origin` or `METAMCP_ALLOWED_ORIGINS`.

MetaMCP serves legacy MCP clients and the 2026-07-28 stateless request envelope over stdio and Streamable HTTP. See [Architecture](docs/ARCHITECTURE.md) for the supported boundary and deployment guidance.

## Evidence

Completed `mcp_call` and `mcp_run` attempts are serialized into `.metamcp/ledger.jsonl`. Export a portable hash-linked bundle:

```bash
metamcp export-evidence \
  --ledger .metamcp/ledger.jsonl \
  --out .metamcp/evidence-bundle.json

metamcp export-evidence --out .metamcp/evidence-bundle.json --verify
```

The operational ledger is not a remote attestation system. The export detects later changes inside a bundle; it does not prove that a compromised host recorded every event.

## Optional gallery

The package still ships a human-operated server gallery:

```bash
metamcp add --list
metamcp add playwright sentry --config .mcp.json
```

The runtime never installs packages in response to an MCP tool call. Installation remains an explicit CLI/user action.

## Upgrade from 0.x

Version 1.0 intentionally removes the model-facing provisioning, skill-advice, and JavaScript execution tools. It also changes HTTP binding, child environment inheritance, retries, and `init`. Read [Migration to 1.0](docs/MIGRATION-1.0.md) before upgrading.

## Security

Child MCP servers are trusted local or remote code with their own permissions. MetaMCP is a policy and lifecycle boundary, not an OS sandbox for untrusted packages. Review commands, pin packages where appropriate, scope credentials per child, and keep dangerous direct servers behind client-side human approval.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm run typecheck
npm test
./scripts/smoke-test.sh
```

Apache-2.0 licensed. Maintained by [Mentu AI](https://mentu.ai).
