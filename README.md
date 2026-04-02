# MetaMCP

[![npm version](https://img.shields.io/npm/v/@mentu/metamcp)](https://www.npmjs.com/package/@mentu/metamcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![CI](https://github.com/mentu-ai/metamcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mentu-ai/metamcp/actions/workflows/ci.yml)

MetaMCP connects all your MCP servers through one. Your model sees 4 tools instead of hundreds.

Think of it like a power strip for MCP servers. Plug in as many as you need -- playwright, databases, GitHub, custom tools -- and your LLM talks to one server that handles everything behind the scenes.

```
                        ┌─── playwright (52 tools)
                        │
LLM ──► MetaMCP ────────┼─── fetch (3 tools)
        (4 tools)       │
                        ├─── sqlite (6 tools)
                        │
                        └─── ... N more servers
```

## Why MetaMCP?

Every MCP server you add registers its tool schemas with the LLM. Each schema eats context tokens. At 5 servers with 20 tools each, that's ~15,000 tokens spent on schemas alone -- every single request.

MetaMCP collapses all of that into 4 tools (~1,000 tokens). That cost stays constant whether you run 3 servers or 30. Less token overhead, better tool selection accuracy, more room for actual work.

Beyond token savings, MetaMCP handles the things you shouldn't have to think about: connection pooling, process lifecycle, error recovery, schema caching, and transport differences between local and remote servers.

## Quick Start

**Install and run:**

```bash
npx @mentu/metamcp              # run directly (no install)
npm install -g @mentu/metamcp    # or install globally
```

**Auto-configure your editor** (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, and more):

```bash
npx @mentu/metamcp init
```

**Or create a `.mcp.json` manually:**

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

```bash
npx @mentu/metamcp --config .mcp.json
```

That's it. MetaMCP speaks MCP over stdio -- point any MCP client at it.

> **Note:** MetaMCP optionally uses `better-sqlite3` for semantic search. This requires a C++ compiler. If compilation fails, MetaMCP still works with keyword-only search. On macOS: `xcode-select --install`. On Linux: `apt install build-essential`.

## The 4 Tools

Instead of exposing every tool from every server, MetaMCP gives the LLM exactly 4:

### `mcp_discover` -- Find tools

Search tool catalogs across all connected servers. Without a query, returns server status and tool counts.

```json
{ "query": "screenshot" }
```

### `mcp_provision` -- Get what you need

Describe a capability and MetaMCP resolves the right server. It searches local catalogs first, then the npm registry for installable servers.

```json
{ "intent": "I need to crawl a website and extract links" }
```

### `mcp_call` -- Use a tool

Forward a tool call to a specific server. MetaMCP handles connection management and retries on crash.

```json
{ "server": "playwright", "tool": "browser_navigate", "args": { "url": "https://example.com" } }
```

### `mcp_execute` -- Write code

Run JavaScript in a V8 sandbox with access to all provisioned servers. Compose multi-step workflows, loops, and conditionals in a single call.

```json
{ "code": "const result = await servers.sqlite.call('query', { sql: 'SELECT count(*) FROM users' }); return result;" }
```

## Configuration

MetaMCP reads `.mcp.json` -- the same format used by Claude Desktop and Claude Code.

**Local server:**

```json
{
  "mcpServers": {
    "my-server": {
      "command": "/usr/local/bin/my-mcp-server",
      "args": ["--port", "8080"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

**Remote server (SSE):**

```json
{
  "mcpServers": {
    "remote-tools": {
      "url": "https://mcp.example.com/sse",
      "transportType": "sse",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

**Remote server (HTTP) with OAuth:**

```json
{
  "mcpServers": {
    "cloud-server": {
      "url": "https://mcp.example.com/api",
      "oauth": true
    }
  }
}
```

**Server lifecycle:**

```json
{
  "mcpServers": {
    "database": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "/path/to/db"],
      "lifecycle": { "mode": "keep-alive", "idleTimeoutMs": 600000 }
    },
    "one-shot": {
      "command": "/usr/local/bin/converter",
      "lifecycle": "ephemeral"
    }
  }
}
```

Three transport types: `stdio` (local, default), `http` (Streamable HTTP), and `sse` (Server-Sent Events). OAuth triggers a browser flow on first connect, with tokens saved to `~/.metamcp/oauth/`.

Lifecycle controls idle behavior: `keep-alive` servers persist, `ephemeral` servers tear down immediately after use, and servers without a declaration follow the default pool timeout.

## What MetaMCP handles for you

- **Connection pool** -- bounded pool with LIFO idle eviction. Servers start lazily on first use.
- **Circuit breaker** -- per-server failure tracking. Errors are classified: auth failures (401/403) never trip the breaker, only transient errors count.
- **Schema caching** -- tool schemas persist to disk for fast cold starts. Stale caches refresh transparently.
- **Config import** -- `--import` discovers servers from Cursor, Claude Desktop, Claude Code, VS Code, Windsurf, Codex, and OpenCode.
- **V8 sandbox** -- `mcp_execute` runs in a locked-down context. No `eval`, no `require`, no network access.
- **Multi-transport** -- stdio, HTTP, and SSE with OAuth. The model doesn't know the difference.

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | `.mcp.json` | Path to config file |
| `--max-connections <n>` | `20` | Connection pool max size |
| `--idle-timeout <ms>` | `300000` | Idle connection timeout |
| `--failure-threshold <n>` | `5` | Circuit breaker failures before trip |
| `--cooldown <ms>` | `30000` | Circuit breaker cooldown |
| `--import` | off | Import configs from installed editors |

## Documentation

Full docs at [metamcp.org](https://metamcp.org).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Links

- [Documentation](https://metamcp.org)
- [npm](https://www.npmjs.com/package/@mentu/metamcp)
- [GitHub](https://github.com/mentu-ai/metamcp)

## License

[Apache-2.0](LICENSE)
