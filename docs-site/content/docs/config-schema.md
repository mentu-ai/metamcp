---
title: "Config Schema"
category: "Reference"
excerpt: "Complete reference for the .mcp.json configuration file."
description: "Schema reference for MetaMCP's .mcp.json configuration file, including server entry fields, defaults, and example configurations."
---

## File format

MetaMCP reads `.mcp.json`, a JSON file with a single top-level key: `mcpServers`. This is the same format used by Claude Desktop and Claude Code.

```json
{
  "mcpServers": {
    "<server-name>": { ... },
    "<server-name>": { ... }
  }
}
```

## Top-level structure

| Key | Type | Description |
|-----|------|-------------|
| `mcpServers` | `Record<string, ServerEntry>` | Map of server names to their configurations. Each key becomes the server's identifier used in `mcp_call` and the `servers` Proxy in `mcp_execute`. |

## Server entry fields

Each server entry supports the following fields:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `command` | string | yes | | The executable to run. Can be a bare command name (resolved via PATH) or an absolute path. |
| `args` | string[] | no | `[]` | Arguments passed to the command. |
| `env` | Record<string, string> | no | `{}` | Environment variables scoped to this server's process. These are merged with the parent environment but do not leak to other servers. |

All configured servers are assigned `"vital"` criticality by default, which means they get automatic retry-on-crash behavior (one retry attempt).

## Default values

These defaults apply to the MetaMCP server process itself, configured via CLI flags:

| Setting | Default | CLI Flag |
|---------|---------|----------|
| Config path | `.mcp.json` (current directory) | `--config` |
| Pool max connections | 20 | `--max-connections` |
| Pool reserve size | 0 | (not configurable via CLI) |
| Pool minimum size | 0 | (not configurable via CLI) |
| Reserve pool timeout | 5000ms | (not configurable via CLI) |
| Idle connection timeout | 300,000ms (5 minutes) | `--idle-timeout` |
| Circuit breaker threshold | 5 consecutive failures | `--failure-threshold` |
| Circuit breaker cooldown | 30,000ms (30 seconds) | `--cooldown` |

## Example configurations

### Minimal: one server via npx

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

### Multi-server setup

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "sqlite": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite", "/path/to/db.sqlite"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token"
      }
    }
  }
}
```

### With environment variables

```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slack"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_TEAM_ID": "T01234567"
      }
    }
  }
}
```

Environment variables in the `env` field are passed only to that server's child process. They do not affect MetaMCP or other servers.

### Local binary with absolute path

```json
{
  "mcpServers": {
    "custom": {
      "command": "/usr/local/bin/my-mcp-server",
      "args": ["--verbose", "--port", "9090"]
    }
  }
}
```

## Config locations

MetaMCP looks for the config file in this order:

1. The path specified by `--config` (if provided).
2. `.mcp.json` in the current working directory.

If the file is not found and a `.mcp.example.json` exists in the working directory, MetaMCP logs a warning suggesting you copy it.

If no config file is found at all, MetaMCP starts with zero child servers. You can still use `mcp_provision` to discover and add servers at runtime.

## Server names

The key in the `mcpServers` object becomes the server's name. This name is used:

- As the `server` parameter in `mcp_call`
- As the property name on the `servers` Proxy in `mcp_execute` (e.g., `servers.playwright`)
- In `mcp_discover` results and status output

Choose short, descriptive names without spaces or special characters.
