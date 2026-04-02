---
title: "Tool Reference"
category: "Reference"
excerpt: "Complete parameter schemas and examples for all four MetaMCP tools."
description: "Detailed reference for mcp_discover, mcp_provision, mcp_call, and mcp_execute, including parameter tables, examples, and response formats."
---

## mcp_discover

Search tool catalogs across all child MCP servers. Without a query, returns server status and tool counts.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | no | Search query for tools |
| `server` | string | no | Filter to a specific server |

### Example 1: List all servers

Request (no parameters):

```json
{}
```

Response:

```json
[
  {
    "name": "playwright",
    "state": "idle",
    "toolCount": 52,
    "criticality": "vital"
  },
  {
    "name": "sqlite",
    "state": "idle",
    "toolCount": 6,
    "criticality": "vital"
  }
]
```

### Example 2: Search for a capability

```json
{ "query": "screenshot" }
```

Response:

```json
[
  {
    "tool": "browser_screenshot",
    "server": "playwright",
    "description": "Take a screenshot of the current page",
    "score": 12,
    "confidence": 0.95
  }
]
```

### Example 3: Filter to a specific server

```json
{ "server": "playwright" }
```

Returns the status of only the `playwright` server and its tools.

---

## mcp_provision

Intent-based provisioning. Describe what you need, and MetaMCP resolves and optionally provisions the right server.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `intent` | string | yes | What capability you need |
| `context` | string | no | Additional context for resolution |
| `autoProvision` | boolean | no | Auto-provision if trusted (default: false) |

### Example 1: Find a server for a capability

```json
{ "intent": "I need to crawl a website and extract links" }
```

Response (local match):

```json
{
  "source": "local",
  "tools": [
    {
      "tool": "browser_navigate",
      "server": "playwright",
      "description": "Navigate to a URL",
      "confidence": 0.87
    }
  ]
}
```

### Example 2: With context

```json
{
  "intent": "database access",
  "context": "I need to query a PostgreSQL database with read-only access"
}
```

The context string is appended to the intent for more precise matching.

### Example 3: With autoProvision enabled

```json
{
  "intent": "I need to interact with GitHub issues",
  "autoProvision": true
}
```

Response (registry match, trusted):

```json
{
  "source": "registry",
  "matches": [
    {
      "name": "@modelcontextprotocol/server-github",
      "description": "GitHub API integration",
      "confidence": 0.92,
      "trusted": true,
      "autoProvisionable": true,
      "installCommand": "npx -y @modelcontextprotocol/server-github"
    }
  ]
}
```

If `autoProvision` is false (the default), the `trusted` and `autoProvisionable` fields are omitted.

---

## mcp_call

Forward a tool call to a specific child MCP server. Retries once on crash for vital servers.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | string | yes | Target server name |
| `tool` | string | yes | Tool name to call |
| `args` | object | no | Arguments to pass to the tool |

### Example 1: Simple call

```json
{
  "server": "playwright",
  "tool": "browser_navigate",
  "args": { "url": "https://example.com" }
}
```

### Example 2: Call with complex arguments

```json
{
  "server": "sqlite",
  "tool": "query",
  "args": {
    "sql": "SELECT name, email FROM users WHERE created_at > ? ORDER BY created_at DESC LIMIT 10",
    "params": ["2024-01-01"]
  }
}
```

### Example 3: Call with no arguments

```json
{
  "server": "playwright",
  "tool": "browser_screenshot"
}
```

When `args` is omitted, the tool is called with no arguments.

---

## mcp_execute

Execute JavaScript code in a V8 sandbox with access to all provisioned servers. Supports async/await, `sleep(ms)`, and `console.log`.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | yes | JavaScript code to execute |

### Sandbox limits

| Limit | Value |
|-------|-------|
| Max code size | 50KB |
| Execution timeout | 120,000ms (120s) |
| Max sleep per call | 30,000ms (30s) |
| Max output size | 10MB |

### Example 1: Simple single-server call

```json
{
  "code": "const result = await servers.sqlite.call('query', { sql: 'SELECT count(*) FROM users' }); return result;"
}
```

### Example 2: Multi-server composition

```json
{
  "code": "await servers.playwright.call('browser_navigate', { url: 'https://example.com' }); const screenshot = await servers.playwright.call('browser_screenshot', {}); const dbStatus = await servers.sqlite.call('query', { sql: 'SELECT 1' }); return { screenshot, dbStatus };"
}
```

### Example 3: With sleep and console output

```json
{
  "code": "console.log('Navigating...'); await servers.playwright.call('browser_navigate', { url: 'https://example.com' }); await sleep(2000); console.log('Taking screenshot...'); const result = await servers.playwright.call('browser_screenshot', {}); return result;"
}
```

Response includes captured console output prepended to the return value:

```
Navigating...
Taking screenshot...
{ ... screenshot data ... }
```

### Available globals

The sandbox provides: `JSON`, `Math`, `Date`, `Array`, `Map`, `Set`, `Promise`, `Object`, `String`, `Number`, `Boolean`, `RegExp`, `Error`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `encodeURIComponent`, `decodeURIComponent`, `encodeURI`, `decodeURI`, `setTimeout`, `clearTimeout`, `console`, `sleep`, and the `servers` Proxy.

Not available: `process`, `require`, `module`, `exports`, `Buffer`, `__dirname`, `__filename`, `eval` (throws EvalError), `Function` constructor, `SharedArrayBuffer`, `WebAssembly`, `fetch`, `globalThis`.

---

## Response format

All tools return MCP-standard `content` arrays with `type: "text"` entries. The text content is typically JSON-formatted.

```json
{
  "content": [
    {
      "type": "text",
      "text": "{ ... JSON response ... }"
    }
  ]
}
```

## Error handling

When a tool call fails, the response includes `isError: true` and an error message in the content.

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error calling browser_navigate on playwright: Connection refused"
    }
  ],
  "isError": true
}
```

The LLM can inspect the error and retry, adjust arguments, or try a different approach.

For `mcp_execute`, sandbox errors include the prefix `Sandbox error:` or `mcp_execute error:` in the message.
