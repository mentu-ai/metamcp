---
title: "Configuration"
category: "Getting Started"
excerpt: "Config file format, server entries, environment variables, and CLI overrides."
description: "Complete guide to configuring MetaMCP, including the .mcp.json format, server entry fields, environment variables, config discovery, and CLI flag overrides."
---

## Config file format

MetaMCP reads `.mcp.json` by default. The format is the same as Claude Desktop and Claude Code config files.

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "<executable>",
      "args": ["<arg1>", "<arg2>"],
      "env": {
        "<VAR>": "<value>"
      }
    }
  }
}
```

Each key under `mcpServers` is a server name. MetaMCP uses this name to identify the server in `mcp_discover`, `mcp_call`, and `mcp_execute`.

To use a different config file path, pass it with the `--config` flag:

```bash
metamcp --config path/to/my-config.json
```

## Server entry fields

Each server entry supports the following fields:

| Field     | Type                       | Required | Description                                                    |
|-----------|----------------------------|----------|----------------------------------------------------------------|
| `command` | `string`                   | Yes      | Executable to spawn the child server.                          |
| `args`    | `string[]`                 | No       | Arguments passed to the command.                               |
| `env`     | `Record<string, string>`   | No       | Environment variables passed to the child server process only. |

> **Note:** The config parser sets `criticality` to `'vital'` by default for all servers. Vital servers are prioritized in the connection pool and trigger warnings on failure.

## npx packages

Most MCP servers are distributed as npm packages. Use `npx` as the command to run them without a global install:

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

The `-y` flag auto-confirms the npx install prompt. Without it, npx may hang waiting for user confirmation.

You can pin a specific version by replacing `@latest` with a version number (e.g., `@playwright/mcp@0.0.10`).

## Local binaries

For servers installed locally or built from source, use an absolute path:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "/usr/local/bin/my-mcp-server",
      "args": ["--port", "3000"]
    }
  }
}
```

> **Warning:** Relative paths are resolved from the working directory where MetaMCP starts. Use absolute paths to avoid issues when MetaMCP is launched by Claude Desktop or other clients.

## Environment variables

Pass server-specific environment variables using the `env` field:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Environment variables in the `env` field are passed only to that child server's process. They do not leak to other servers or to MetaMCP itself.

> **Tip:** For secrets, consider referencing environment variables from your shell instead of hardcoding them in the config file. Set them in your shell profile and they will be inherited by MetaMCP's child processes.

## Config discovery

The `metamcp init` command auto-detects installed MCP clients and configures them to use MetaMCP:

```bash
metamcp init
```

This detects Claude Desktop, Claude Code, and other supported clients. It writes the appropriate config entries so you do not need to edit config files manually.

For the full list of init options, see [CLI Reference](/reference/cli-reference).

## CLI overrides

CLI flags override the built-in defaults for connection pool and circuit breaker behavior. Pass them when starting MetaMCP:

```bash
metamcp --config .mcp.json --max-connections 10 --idle-timeout 60000
```

| Flag                     | Default    | Description                                              |
|--------------------------|------------|----------------------------------------------------------|
| `--config <path>`        | `.mcp.json`| Path to the config file.                                 |
| `--max-connections <n>`  | `20`       | Maximum concurrent child server connections.             |
| `--idle-timeout <ms>`    | `300000`   | Idle connection timeout in milliseconds (5 minutes).     |
| `--failure-threshold <n>`| `5`        | Number of failures before the circuit breaker trips.     |
| `--cooldown <ms>`        | `30000`    | Circuit breaker cooldown period in milliseconds (30s).   |

For the complete CLI reference, see [CLI Reference](/reference/cli-reference).

## Next steps

- [Adding Servers](/guides/adding-servers) for patterns and tips on configuring different types of child servers.
- [Config Schema Reference](/reference/config-schema) for the full JSON schema of `.mcp.json`.
