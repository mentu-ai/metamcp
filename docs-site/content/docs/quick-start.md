---
title: "Quick Start"
category: "Getting Started"
excerpt: "Get MetaMCP running and make your first tool calls in minutes."
description: "Step-by-step guide to creating a config file, starting MetaMCP, connecting it to Claude Desktop or Claude Code, and making your first discovery, call, and code execution."
---

## Create a config file

Create a file called `.mcp.json` in your project directory. This file defines the child MCP servers that MetaMCP will manage.

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

This registers two child servers: Playwright (browser automation, 52 tools) and SQLite (database operations, 6 tools). Replace `/path/to/db` with the actual path to your SQLite database file.

The format is the same as Claude Desktop and Claude Code config files. If you already have a `.mcp.json`, you can use it directly.

> **Note:** Child servers are spawned lazily. MetaMCP does not start them until the LLM requests a tool from that server.

## Start MetaMCP

```bash
npx metamcp --config .mcp.json
```

MetaMCP reads the config, registers its 4 meta-tools via MCP stdio, and waits for requests. You will not see output in the terminal because communication happens over stdio.

## Connect to Claude Desktop

The fastest way to configure Claude Desktop is the init command:

```bash
metamcp init
```

This auto-detects your Claude Desktop installation and adds MetaMCP to its MCP server config.

To configure manually, open Claude Desktop's config file and add MetaMCP as a server:

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

> **Warning:** Use an absolute path for the `--config` value. Claude Desktop does not resolve relative paths from your project directory.

Restart Claude Desktop after updating the config. For detailed setup, see [Claude Desktop Integration](/integrations/claude-desktop).

## Connect to Claude Code

Add MetaMCP using the CLI:

```bash
claude mcp add metamcp npx metamcp --config /absolute/path/to/.mcp.json
```

Or add it manually to your project's `.mcp.json` or `~/.claude/settings.json`:

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

For detailed setup, see [Claude Code Integration](/integrations/claude-code).

## Your first discovery

Once connected, ask the LLM to discover available tools. MetaMCP uses the `mcp_discover` tool.

**List all servers and their status:**

```json
{
  "tool": "mcp_discover"
}
```

With no query, `mcp_discover` returns the list of registered servers with their status and tool counts. This is useful to verify that your config loaded correctly.

**Search for specific tools:**

```json
{
  "tool": "mcp_discover",
  "args": {
    "query": "screenshot"
  }
}
```

This searches across all child server tool catalogs using hybrid search (semantic + keyword). It returns matching tools with their server name, tool name, and description.

**Filter by server:**

```json
{
  "tool": "mcp_discover",
  "args": {
    "server": "playwright"
  }
}
```

This lists all tools from a specific server.

## Your first tool call

Use `mcp_call` to forward a tool call to a child server. MetaMCP handles the connection, invocation, and result forwarding.

```json
{
  "tool": "mcp_call",
  "args": {
    "server": "playwright",
    "tool": "browser_navigate",
    "args": {
      "url": "https://example.com"
    }
  }
}
```

MetaMCP spawns the Playwright server (if not already running), calls `browser_navigate`, and returns the result. If the child server crashes during the call, MetaMCP retries once automatically.

## Your first code execution

Use `mcp_execute` to run JavaScript in a V8 sandbox. This is MetaMCP's code-mode, where you can compose multi-step workflows across multiple servers in a single call.

```json
{
  "tool": "mcp_execute",
  "args": {
    "code": "const tables = await servers.sqlite.call('list_tables', {});\nconst results = [];\nfor (const table of tables) {\n  const schema = await servers.sqlite.call('describe_table', { table_name: table.name });\n  results.push({ table: table.name, columns: schema.columns.length });\n}\nreturn results;"
  }
}
```

Inside the sandbox, you have access to:

- **`servers.<name>.call(tool, args)`** to call any provisioned server's tools.
- **`async/await`** for asynchronous operations.
- **`sleep(ms)`** to pause execution.
- **`console.log()`** for debug output included in the response.

The sandbox is isolated in V8 with no access to the host filesystem, network, or Node.js APIs.

> **Tip:** Code-mode is most useful when the LLM needs to loop over results, apply conditional logic, or compose calls across multiple servers. For single tool calls, `mcp_call` is simpler.

## Next steps

- [Configuration](/configuration) for all config file options and CLI flags.
- [The Four Tools](/concepts/the-four-tools) for detailed reference on each meta-tool.
- [Code Mode](/guides/code-mode) for advanced sandbox patterns and examples.
