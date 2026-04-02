---
title: "Claude Code Setup"
category: "Guides"
excerpt: "Connect MetaMCP to Claude Code."
description: "Configure MetaMCP as an MCP server in Claude Code at the project or user level."
---

## Prerequisites

- Claude Code installed
- Node.js 20 or later
- MetaMCP installed (`npm install -g metamcp`) or available via npx

## Automatic setup

Run the init command:

```bash
metamcp init
```

MetaMCP detects Claude Code and writes the server entry to `~/.claude.json`. Use `--yes` to skip prompts, or `--json` for structured output.

## Manual setup: project-level

Add MetaMCP to the project's `.mcp.json` (or a dedicated file like `.mcp-servers.json`):

```json
{
  "mcpServers": {
    "metamcp": {
      "command": "npx",
      "args": ["metamcp", "--config", ".mcp.json"]
    }
  }
}
```

> **Note:** MetaMCP's own config (the file listing child servers) can be the same `.mcp.json` file or a separate file. If it is the same file, MetaMCP reads the `mcpServers` key for its child servers. To keep things clear, you may use a separate file for MetaMCP's child server list and point to it with `--config`.

## Manual setup: user-level

To make MetaMCP available in all Claude Code sessions, edit `~/.claude.json`:

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

User-level config requires an absolute path for the `--config` flag.

## Verify the connection

In Claude Code, type a message that triggers tool discovery:

```
What MCP servers are available?
```

This calls `mcp_discover` with no arguments. You should see each configured server with its state and tool count.

## Workflow examples

**Discover tools for a capability:**

```
Find me tools for database operations.
```

This calls `mcp_discover` with `query: "database"` and returns matching tools across all servers.

**Call a specific tool:**

```
Use the sqlite server to run: SELECT count(*) FROM users
```

This calls `mcp_call` with `server: "sqlite"`, `tool: "query"`, and the SQL arguments.

**Multi-step code mode:**

```
Navigate to example.com, wait 2 seconds, then take a screenshot.
```

This calls `mcp_execute` with a code block combining Playwright operations and `sleep()`.

## Environment variables

If child servers need environment variables (API tokens, database URLs), set them in the MetaMCP config's `env` field, not in the Claude Code config.

```json
{
  "mcpServers": {
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

The `env` field is scoped to that specific child server's process.

## Troubleshooting

**Relative vs absolute paths:**
- Project-level configs can use relative paths (resolved from the project root).
- User-level configs (`~/.claude.json`) must use absolute paths.

**Permission denied on npx:**
- Ensure `npx` is in your PATH. Run `which npx` to verify.
- If using nvm, make sure the correct Node.js version is active.

**Server not connecting:**
- Run `mcp_discover` with no arguments to see server states.
- A server in `"failed"` state may have a bad command or missing dependency.

See [Troubleshooting](/reference/troubleshooting) for more diagnostic steps.

## Next steps

- [Code Mode](/guides/code-mode) for multi-step workflows
- [Tool Reference](/reference/tool-reference) for complete parameter schemas
