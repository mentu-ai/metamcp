---
title: "Claude Desktop Setup"
category: "Guides"
excerpt: "Connect MetaMCP to Claude Desktop."
description: "Configure MetaMCP as an MCP server in Claude Desktop with automatic or manual setup."
---

## Prerequisites

- Claude Desktop installed on macOS
- Node.js 20 or later
- MetaMCP installed (`npm install -g metamcp`) or available via npx

## Automatic setup

Run the init command:

```bash
metamcp init
```

MetaMCP auto-detects Claude Desktop and writes the server entry to its config file at:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Expected output:

```
Binary: /path/to/metamcp/dist/index.js
  + Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json (updated)

Done: 1 configured, 0 failed
```

The init command also configures other detected clients (Claude Code, Cursor, VS Code, Windsurf, Zed, Gemini CLI, GitHub Copilot CLI, Codex). Use `--yes` to skip confirmation prompts, or `--json` for structured output.

## Manual setup

Edit the Claude Desktop config file directly:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add MetaMCP under `mcpServers`:

```json
{
  "mcpServers": {
    "metamcp": {
      "command": "npx",
      "args": ["metamcp", "--config", "/absolute/path/to/.mcp.json"]
    }
  }
}
```

> **Note:** The `--config` path must be absolute. Claude Desktop does not resolve relative paths the same way a terminal does.

If you installed MetaMCP globally, you can use `metamcp` directly:

```json
{
  "mcpServers": {
    "metamcp": {
      "command": "metamcp",
      "args": ["--config", "/absolute/path/to/.mcp.json"]
    }
  }
}
```

## Restart Claude Desktop

After editing the config, restart Claude Desktop for changes to take effect. The MCP server connection is established at startup.

## Verify the connection

In Claude Desktop, ask the assistant to discover available tools:

```
What tools are available via MetaMCP?
```

This triggers `mcp_discover` with no arguments, which returns the list of connected servers and their tool counts. You should see entries for each server defined in your `.mcp.json`.

## Troubleshooting

**"Server not found" or no tools appear:**
- Check that the `--config` path points to a valid `.mcp.json` file.
- Verify the path is absolute, not relative.

**"command not found" error:**
- Node.js may not be in Claude Desktop's PATH. Use the full path to `node` and pass the MetaMCP entry point as an argument:

```json
{
  "mcpServers": {
    "metamcp": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/metamcp/dist/index.js", "--config", "/path/to/.mcp.json"]
    }
  }
}
```

**Config file does not exist:**
- The init command creates the file if it does not exist. For manual setup, create the file with the JSON structure shown above.

See [Troubleshooting](/reference/troubleshooting) for more diagnostic steps.

## Next steps

- [Claude Code Setup](/guides/claude-code) for CLI integration
- [Quick Start](/quick-start) for creating your first `.mcp.json`
