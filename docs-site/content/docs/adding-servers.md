---
title: "Adding Servers"
category: "Guides"
excerpt: "Add child MCP servers to MetaMCP."
description: "How to add npx packages, local binaries, and environment variables to your MetaMCP configuration."
---

## Config format recap

MetaMCP reads its server list from `.mcp.json`, a JSON file with a single top-level key: `mcpServers`. Each entry defines a child server by name. See [Configuration](/configuration) for the full schema.

```json
{
  "mcpServers": {
    "server-name": {
      "command": "...",
      "args": ["..."],
      "env": {}
    }
  }
}
```

## Adding an npx package

Most MCP servers are distributed as npm packages and run via `npx`. To add one:

1. Find the package name (e.g., `@playwright/mcp`).
2. Add an entry to `.mcp.json` with `"command": "npx"` and the package in `args`.
3. Restart MetaMCP, or let lazy spawning connect on first use.

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

The `-y` flag tells npx to auto-confirm installation if the package is not already cached.

## Adding a local binary

If you have a compiled MCP server or a script on disk, use the absolute path as the command.

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

Always use absolute paths. Relative paths resolve against the working directory where MetaMCP was started, which may not be what you expect.

## Setting environment variables

The `env` field passes environment variables to a specific child server's process. These variables are scoped to that server only. Other servers and MetaMCP itself do not see them.

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

> **Tip:** Keep tokens out of version control. Use a `.mcp.json` that is gitignored, or reference a secrets manager in your workflow.

## Common servers

| Name | Package | Description |
|------|---------|-------------|
| Playwright | `@playwright/mcp` | Browser automation with Playwright |
| Fetch | `@modelcontextprotocol/server-fetch` | HTTP fetch and web scraping |
| SQLite | `@modelcontextprotocol/server-sqlite` | SQLite database access |
| GitHub | `@modelcontextprotocol/server-github` | GitHub API integration |
| Filesystem | `@modelcontextprotocol/server-filesystem` | File system operations |
| Memory | `@modelcontextprotocol/server-memory` | Knowledge graph memory |

## Verifying the connection

After adding a server, use `mcp_discover` with no query to see all server statuses and tool counts.

```json
{ "name": "mcp_discover" }
```

Expected output:

```json
[
  {
    "name": "playwright",
    "state": "idle",
    "toolCount": 52,
    "criticality": "vital"
  },
  {
    "name": "github",
    "state": "idle",
    "toolCount": 18,
    "criticality": "vital"
  }
]
```

If a server shows `"state": "failed"`, check that the command and args are correct. See [Troubleshooting](/reference/troubleshooting) for common issues.

## Next steps

- [Code Mode](/guides/code-mode) for multi-step workflows across servers
- [Connection Pool](/concepts/connection-pool) to understand how MetaMCP manages server lifecycles
