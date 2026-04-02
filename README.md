# MetaMCP

[![npm version](https://img.shields.io/npm/v/@mentu/metamcp)](https://www.npmjs.com/package/@mentu/metamcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![CI](https://github.com/mentu-ai/metamcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mentu-ai/metamcp/actions/workflows/ci.yml)

MetaMCP is a meta-MCP server that sits in front of N child MCP servers, collapsing hundreds of tools into 4 meta-tools (~1,000 schema tokens). Built to be **composable**, **lazy**, **isolated**, and **fast**.

## How It Works

```
                        ┌─── playwright (52 tools)
                        │
LLM ──► MetaMCP ────────┼─── fetch (3 tools)
        (4 tools)       │
                        ├─── sqlite (6 tools)
                        │
                        └─── ... N more servers
```

Your LLM sees 4 tools. MetaMCP handles discovery, routing, connection lifecycle, and sandboxed execution across all child servers.

## Documentation

Full documentation at [metamcp.org](https://metamcp.org).

## Installation

```bash
npx @mentu/metamcp              # run directly (no install)
npm install -g @mentu/metamcp    # or install globally
```

**Auto-configure your MCP client** (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, and more):

```bash
npx @mentu/metamcp init
```

> **Note:** MetaMCP optionally uses `better-sqlite3` for semantic search (vector embeddings). This requires a C++ compiler for native compilation. If compilation fails, MetaMCP still works fully with keyword-only search. On macOS, run `xcode-select --install` if you see build errors. On Linux, install `build-essential`.

## Quick Start

**1. Create a `.mcp.json` in your project root:**

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "sqlite": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "/path/to/db"]
    }
  }
}
```

**2. Run MetaMCP:**

```bash
npx @mentu/metamcp --config .mcp.json
```

**3. Connect your LLM.** MetaMCP speaks MCP over stdio — point Claude Desktop, Claude Code, or any MCP client at it.

## Tools

### `mcp_discover` — Search & list

Search tool catalogs across all child servers. Without a query, returns server status and tool counts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | no | Search query for tools |
| `server` | string | no | Filter to a specific server |

```json
{ "query": "screenshot" }
```

### `mcp_provision` — Intent-based routing

Describe what you need and MetaMCP resolves the right server. Searches local catalogs first, then the npm registry for installable MCP servers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `intent` | string | yes | What capability you need |
| `context` | string | no | Additional context for resolution |
| `autoProvision` | boolean | no | Auto-provision if trusted (default: false) |

```json
{ "intent": "I need to crawl a website and extract links" }
```

### `mcp_call` — Forward to child server

Forward a tool call to a specific child server. Retries once on crash for vital servers.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | yes | Target server name |
| `tool` | string | yes | Tool name to call |
| `args` | object | no | Arguments to pass to the tool |

```json
{ "server": "playwright", "tool": "browser_navigate", "args": { "url": "https://example.com" } }
```

### `mcp_execute` — Sandboxed code execution

Execute code in a V8 sandbox with access to all provisioned servers. Supports `async`/`await`, `sleep(ms)`, and `console.log`. No access to `process`, `require`, `fs`, or the network.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | yes | Code to execute |

```json
{ "code": "const result = await servers.sqlite.call('query', { sql: 'SELECT count(*) FROM users' }); return result;" }
```

## Configuration

MetaMCP reads `.mcp.json` — the same format used by Claude Desktop and Claude Code.

**npx package:**

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

**Local binary:**

```json
{
  "mcpServers": {
    "my-server": {
      "command": "/usr/local/bin/my-mcp-server",
      "args": ["--port", "8080"]
    }
  }
}
```

**With environment variables:**

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | `.mcp.json` | Path to config file |
| `--max-connections <n>` | `20` | Connection pool max size |
| `--idle-timeout <ms>` | `300000` | Idle connection timeout (ms) |
| `--failure-threshold <n>` | `5` | Circuit breaker consecutive failures |
| `--cooldown <ms>` | `30000` | Circuit breaker cooldown (ms) |
| `--help` | | Show help |
| `--version` | | Show version |

## Architecture

MetaMCP manages child server lifecycles with:

- **Connection pool** — bounded pool with LIFO idle list and configurable upper/lower bounds
- **Lazy spawning** — child servers start on first use, not at boot
- **Circuit breaker** — per-server failure tracking with automatic cooldown
- **LIFO eviction** — when the pool is full, the oldest idle connection is evicted first
- **V8 sandbox** — `mcp_execute` runs in a locked-down `vm.Context` with frozen prototypes, no `eval`, no `require`, no network access
- **Trust policy** — registry packages are evaluated before auto-provisioning

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, commit conventions, and PR guidelines.

## Links

- [Documentation](https://metamcp.org)
- [npm package](https://www.npmjs.com/package/@mentu/metamcp)
- [GitHub](https://github.com/mentu-ai/metamcp)

## License

[Apache-2.0](LICENSE)
