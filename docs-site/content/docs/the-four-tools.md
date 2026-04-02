---
title: "The Four Tools"
category: "Concepts"
excerpt: "The four meta-tools that replace N individual tools."
description: "MetaMCP exposes exactly 4 tools to the LLM regardless of how many child servers are connected. Learn what each tool does and when to use it."
---

## Overview

MetaMCP exposes exactly 4 tools to the LLM, no matter how many child MCP servers are connected. These 4 tools total approximately 1,000 schema tokens.

Traditional MCP setups register every child server's tools directly with the LLM. Five servers with 20 tools each means 100 tool schemas in the context window, roughly 15,000 tokens consumed before the conversation even starts. MetaMCP collapses that surface area down to 4 stable tools that act as a routing layer.

The four tools are:

| Tool | Purpose |
|------|---------|
| `mcp_discover` | Search and list tool catalogs |
| `mcp_provision` | Intent-based routing and server provisioning |
| `mcp_call` | Forward a tool call to a specific child server |
| `mcp_execute` | Code-mode execution in a V8 sandbox |

## mcp_discover

Search tool catalogs across all child MCP servers and list server status.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | No | Search term for tool names and descriptions |
| `server` | string | No | Filter results to a specific server |

Without a query, `mcp_discover` returns the list of connected servers with their status and tool counts. With a query, it searches tool names and descriptions using hybrid scoring (keyword + semantic when configured).

**Example: List all servers**

```json
{}
```

**Example: Search for screenshot tools**

```json
{
  "query": "screenshot"
}
```

This returns matching tools ranked by relevance, with each result including the tool name, description, server name, and match score.

For details on how search ranking works, see [Discovery & Search](/concepts/discovery).

## mcp_provision

Intent-based provisioning. Describe what you need, and MetaMCP resolves and provisions the right server.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `intent` | string | Yes | - | Natural language description of the capability needed |
| `context` | string | No | - | Additional context to refine the search |
| `autoProvision` | boolean | No | `false` | Automatically install and start a matching server |

`mcp_provision` searches local catalogs first. If no local server matches the intent, it queries the npm registry for published MCP servers. When `autoProvision` is true, a matched server is installed and started automatically.

**Example: Find a server for web crawling**

```json
{
  "intent": "I need to crawl a website and extract links"
}
```

This searches local tool catalogs for matching capabilities. If nothing is found locally, it queries the MCP server registry at `registry.modelcontextprotocol.io` for published servers that match the intent.

For details on automatic provisioning, see [Auto-Provisioning](/guides/auto-provisioning).

## mcp_call

Forward a tool call to a specific child MCP server.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | Yes | Name of the child server |
| `tool` | string | Yes | Name of the tool to call |
| `args` | object | No | Arguments to pass to the tool |

`mcp_call` is the most common tool for direct invocations. It provides explicit routing: you name the server, name the tool, and pass the arguments. If the target server crashes during the call, MetaMCP retries once automatically for vital servers.

**Example: Navigate a browser**

```json
{
  "server": "playwright",
  "tool": "browser_navigate",
  "args": {
    "url": "https://example.com"
  }
}
```

**Example: Run a database query**

```json
{
  "server": "sqlite",
  "tool": "query",
  "args": {
    "sql": "SELECT count(*) FROM users"
  }
}
```

The server is lazily spawned on first use. If the server is not already running, MetaMCP starts it from the connection pool before forwarding the call.

## mcp_execute

Code-mode execution in a V8 sandbox. Write JavaScript that composes calls across multiple servers in a single tool invocation.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | Yes | JavaScript code to execute in the sandbox |

Inside the sandbox, provisioned servers are available via `servers.<name>.call(tool, args)`. The code supports async/await, `sleep(ms)` for delays, and `console.log` for output capture.

**Example: Query a database and return the result**

```json
{
  "code": "const result = await servers.sqlite.call('query', { sql: 'SELECT count(*) FROM users' }); return result;"
}
```

**Example: Multi-step workflow across servers**

```json
{
  "code": "const page = await servers.playwright.call('browser_navigate', { url: 'https://example.com' });\nconst screenshot = await servers.playwright.call('browser_screenshot', {});\nawait sleep(1000);\nconst analysis = await servers.vision.call('analyze_image', { image: screenshot });\nreturn analysis;"
}
```

Code mode saves round-trips and tokens when the LLM needs to chain multiple tool calls together. Instead of 4 separate tool calls (4 round-trips), a single `mcp_execute` call handles the entire workflow.

For sandbox security details, see [V8 Sandbox](/concepts/sandbox). For usage patterns, see [Code Mode](/guides/code-mode).

## Decision Tree

Use this to determine which tool fits your situation:

| Situation | Tool |
|-----------|------|
| "I want to find what tools are available" | `mcp_discover` |
| "I need a capability but don't know which server has it" | `mcp_provision` |
| "I know the server and tool name" | `mcp_call` |
| "I need to combine multiple tool calls in sequence" | `mcp_execute` |

A typical workflow progresses through these tools naturally:

1. **Discover** available capabilities with `mcp_discover`.
2. **Provision** a server if the needed tool is not yet available, using `mcp_provision`.
3. **Call** individual tools directly with `mcp_call`.
4. **Execute** multi-step workflows with `mcp_execute` when chaining is needed.

In practice, the LLM often skips straight to `mcp_call` for well-known servers and tools. Discovery and provisioning are for exploration and bootstrapping.

## Token Comparison

The token savings are significant as server count grows.

| Setup | Tools Registered | Approximate Schema Tokens |
|-------|-----------------|--------------------------|
| 5 servers x 20 tools (traditional) | 100 | ~15,000 |
| 5 servers x 20 tools (MetaMCP) | 4 | ~1,000 |
| 10 servers x 20 tools (traditional) | 200 | ~30,000 |
| 10 servers x 20 tools (MetaMCP) | 4 | ~1,000 |
| 20 servers x 20 tools (traditional) | 400 | ~60,000 |
| 20 servers x 20 tools (MetaMCP) | 4 | ~1,000 |

MetaMCP's token cost stays constant at approximately 1,000 tokens regardless of how many child servers and tools exist behind it. The schema overhead shifts from O(N) to O(1).

This matters because context window space consumed by tool schemas is space not available for conversation history, reasoning, and output. At 20+ servers, traditional MCP setups can lose a meaningful fraction of the context window to schema definitions alone.
