# MetaMCP

[![npm version](https://img.shields.io/npm/v/@mentu/metamcp)](https://www.npmjs.com/package/@mentu/metamcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![CI](https://github.com/mentu-ai/metamcp/actions/workflows/ci.yml/badge.svg)](https://github.com/mentu-ai/metamcp/actions/workflows/ci.yml)

MetaMCP connects all your MCP servers through one. Your model sees 6 tools instead of hundreds.

Think of it like a power strip for MCP servers. Plug in as many as you need -- playwright, databases, GitHub, custom tools -- and your LLM talks to one server that handles everything behind the scenes.

```
                        ┌─── playwright (52 tools)
                        │
LLM ──► MetaMCP ────────┼─── fetch (3 tools)
        (6 tools)       │
                        ├─── sqlite (6 tools)
                        │
                        └─── ... N more servers
```

## Why MetaMCP?

Every MCP server you add registers its tool schemas with the LLM. Each schema eats context tokens. At 5 servers with 20 tools each, that's ~15,000 tokens spent on schemas alone -- every single request.

MetaMCP collapses all of that into 6 tools (~1,300 tokens). That cost stays constant whether you run 3 servers or 30. Less token overhead, better tool selection accuracy, more room for actual work.

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

**Add servers from the built-in gallery** (122 curated servers):

```bash
metamcp add playwright sentry memory postgres    # one-click, writes .mcp.json
metamcp add --list                               # browse all available servers
metamcp add --category search                    # filter by category
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

## The Tools

MetaMCP gives the LLM 6 tools: 4 core tools for server management, and 2 advisory tools for skill awareness.

### Core Tools

#### `mcp_discover` -- Find tools

Search tool catalogs across all connected servers. Without a query, returns server status and tool counts.

```json
{ "query": "screenshot" }
```

#### `mcp_provision` -- Get what you need

Describe a capability and MetaMCP resolves the right server. It searches local catalogs first, then the npm registry for installable servers.

```json
{ "intent": "I need to crawl a website and extract links" }
```

#### `mcp_call` -- Use a tool

Forward a tool call to a specific server. MetaMCP handles connection management and retries on crash.

```json
{ "server": "playwright", "tool": "browser_navigate", "args": { "url": "https://example.com" } }
```

#### `mcp_execute` -- Write code

Run JavaScript in a V8 sandbox with access to all provisioned servers. Compose multi-step workflows, loops, and conditionals in a single call.

```json
{ "code": "const result = await servers.sqlite.call('query', { sql: 'SELECT count(*) FROM users' }); return result;" }
```

### Skill-Aware Tools

Skills are methodology files (`SKILL.md`) that teach agents *how* to use MCP servers effectively. MetaMCP can discover skills and check whether their required MCP servers are available.

#### `mcp_skill_discover` -- Find skills

Search installed skills with MCP readiness status. Returns matching skills, their required servers, and whether those servers are connected.

```json
{ "query": "browser automation" }
```

#### `mcp_skill_advise` -- Pre-flight check

Check whether a specific skill's dependencies are satisfied before using it.

```json
{ "skill": "playwright" }
```

Skills live in `~/.claude/skills/` (personal) or `.claude/skills/` (project). MetaMCP scans both locations and matches skills to their companion MCP servers via the `requires-mcp` frontmatter field. See [Skills](https://metamcp.org/concepts/skills) in the docs.

## Server Gallery

MetaMCP ships with a curated gallery of 122 MCP servers across developer tools, databases, browser automation, search, security, monitoring, and more.

```bash
metamcp add --list                    # browse all servers
metamcp add playwright sentry neon    # add multiple at once
metamcp add --category databases      # filter by category
```

When you add a server that has a companion skill installed, MetaMCP tells you:

```
Added 2 server(s): playwright, sentry

Companion skills detected:
  playwright → skill: playwright
  sentry → skill: sentry
These skills teach agents how to use these servers effectively.
```

See the full gallery at [metamcp.org/guides/server-gallery](https://metamcp.org/guides/server-gallery).

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

### Secret resolution from the vault

Hard-coding `API_KEY` strings in `.mcp.json` is the easiest way to leak credentials into git. MetaMCP supports `${KEY}` references in any `env` or `headers` value and resolves them at config load time:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "remote-tools": {
      "url": "https://mcp.example.com/sse",
      "transportType": "sse",
      "headers": { "Authorization": "Bearer ${REMOTE_TOOLS_TOKEN}" }
    }
  }
}
```

Resolution order for each `${KEY}`:

1. **`mentu vault`** — if [mentu-vault](https://github.com/mentu-ai/mentu-vault) is installed at `~/.local/bin/mentu-vault`, MetaMCP looks up the key in the macOS Keychain (or the age-encrypted file fallback). Workspace-scoped lookup is tried first when `MENTU_WORKSPACE` is set, then global.
2. **`process.env`** — standard environment variable.
3. **Literal** — if neither resolves, MetaMCP logs a warning and leaves the `${KEY}` reference in place so misconfiguration is visible instead of silent.

Vault lookups are cached for the process lifetime, so resolution happens once at startup with no per-connection overhead. Inline references like `"Bearer ${TOKEN}"` and standalone `"${TOKEN}"` are both supported.

If you do not use `mentu vault`, MetaMCP falls back to `process.env` automatically — no extra config needed. Just `export GITHUB_TOKEN=...` and the same `.mcp.json` works.

### Secret scrubbing on the way out

MetaMCP also runs an output scrubber on every tool response before it returns to the LLM. JWTs, OpenAI/GitHub/Slack/AWS tokens, and JSON-shaped credential keys (`password`, `secret`, `api_key`, `access_token`, `private_key`, `authorization`, etc.) are replaced with `[REDACTED:LABEL]`. This is best-effort defense in depth — secrets that match well-known patterns get caught even if a misconfigured downstream server echoes them in an error message.

## What MetaMCP handles for you

- **Connection pool** -- bounded pool with LIFO idle eviction. Servers start lazily on first use.
- **Circuit breaker** -- per-server failure tracking. Errors are classified: auth failures (401/403) never trip the breaker, only transient errors count.
- **Schema caching** -- tool schemas persist to disk for fast cold starts. Stale caches refresh transparently.
- **Config import** -- `--import` discovers servers from Cursor, Claude Desktop, Claude Code, VS Code, Windsurf, Codex, and OpenCode.
- **Hot reload** -- MetaMCP watches `.mcp.json` for changes. Add servers with `metamcp add` and they become available within 2 seconds, no restart needed.
- **V8 sandbox** -- `mcp_execute` runs in a locked-down context. No `eval`, no `require`, no network access.
- **Multi-transport** -- stdio, HTTP, and SSE with OAuth. The model doesn't know the difference.
- **Skill awareness** -- discovers companion skills for MCP servers and checks readiness before invocation.

## CLI

| Command | Description |
|---------|-------------|
| `metamcp` | Start the MetaMCP server (default) |
| `metamcp init` | Auto-configure MetaMCP in all supported MCP clients |
| `metamcp add <server>` | Add server(s) from the gallery to `.mcp.json` |
| `metamcp add --list` | Browse all available servers |

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
