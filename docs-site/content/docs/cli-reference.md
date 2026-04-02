---
title: "CLI Reference"
category: "Reference"
excerpt: "Command-line interface reference for MetaMCP."
description: "Complete reference for MetaMCP CLI commands, flags, supported clients, and usage examples."
---

## Usage

```bash
metamcp [options]
metamcp init [--yes] [--json]
```

## Commands

| Command | Description |
|---------|-------------|
| `run` (default) | Start the MetaMCP server. This is the default when no command is specified. |
| `init` | Auto-configure MetaMCP in all supported MCP clients. |

## Run options

These flags apply when running MetaMCP as a server (the default command).

| Flag | Default | Description |
|------|---------|-------------|
| `--config <path>` | `.mcp.json` | Path to the configuration file |
| `--max-connections <n>` | `20` | Maximum concurrent child server connections |
| `--idle-timeout <ms>` | `300000` | Idle connection timeout in milliseconds (5 minutes) |
| `--failure-threshold <n>` | `5` | Circuit breaker trips after this many consecutive failures |
| `--cooldown <ms>` | `30000` | Circuit breaker cooldown period in milliseconds (30 seconds) |
| `--help` | | Show help message and exit |
| `--version` | | Show version number and exit |

## Init options

These flags apply to the `init` subcommand.

| Flag | Description |
|------|-------------|
| `--yes` | Non-interactive mode. Skip all confirmation prompts. |
| `--json` | Output structured JSON result to stdout instead of human-readable text to stderr. |

## Supported clients

The `init` command detects and configures the following clients:

| Client | Config Path | Format |
|--------|-------------|--------|
| Global | `~/.mcp.json` | JSON |
| Claude Code | `~/.claude.json` | JSON |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | JSON |
| Cursor | `~/.cursor/mcp.json` | JSON |
| VS Code | `~/Library/Application Support/Code/User/mcp.json` | JSON |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | JSON |
| Zed | `~/Library/Application Support/Zed/settings.json` | JSON (nested) |
| Gemini CLI | `~/.gemini/settings.json` | JSON |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | JSON |
| Codex | `~/.codex/config.toml` | TOML |
| Codex (XDG) | `~/.config/codex/config.toml` | TOML |

> **Note:** Zed and Codex configs are only written if the config file or its parent directory already exists. TOML configs use the `[mcp_servers.metamcp]` block. VS Code uses `servers` as the key instead of `mcpServers`.

For each client, `init` either creates a new config file or merges into an existing one. Existing files are backed up to `.bak` before modification.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Clean shutdown or successful init |
| `1` | Error (bad arguments, fatal startup failure) |

## Examples

Start MetaMCP with default settings:

```bash
metamcp --config .mcp.json
```

Run with a larger connection pool and longer idle timeout:

```bash
metamcp --config .mcp.json --max-connections 50 --idle-timeout 600000
```

Run with a stricter circuit breaker (trips after 3 failures, 60s cooldown):

```bash
metamcp --config .mcp.json --failure-threshold 3 --cooldown 60000
```

Auto-configure all detected clients non-interactively:

```bash
metamcp init --yes
```

Get init results as JSON (useful for scripts):

```bash
metamcp init --json
```
