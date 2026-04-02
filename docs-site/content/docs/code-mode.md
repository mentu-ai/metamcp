---
title: "Code Mode"
category: "Guides"
excerpt: "Execute multi-step workflows in a single tool call."
description: "Use mcp_execute to run JavaScript code in a V8 sandbox with access to all provisioned MCP servers."
---

## Why code mode?

Traditional MCP usage requires one tool call per operation. A 5-step workflow means 5 round-trips between the LLM and the server, each consuming tokens for the request, the response, and the next prompt.

`mcp_execute` lets the LLM send a single code block that runs all steps in sequence. One round-trip instead of five. Fewer tokens, lower latency.

## Basic pattern

Inside `mcp_execute`, the `servers` object is a Proxy that routes calls to the correct child server. Each server exposes a single `call(tool, args)` method.

```javascript
const result = await servers.sqlite.call('query', {
  sql: 'SELECT count(*) FROM users'
});
return result;
```

The string after `servers.` must match a server name in your `.mcp.json`.

## Multi-server composition

Combine multiple servers in a single execution. This example navigates to a page with Playwright, then queries a database:

```javascript
// Step 1: Navigate with Playwright
await servers.playwright.call('browser_navigate', {
  url: 'https://example.com/dashboard'
});

// Step 2: Take a screenshot
const screenshot = await servers.playwright.call('browser_screenshot', {});

// Step 3: Query the database for comparison
const dbResult = await servers.sqlite.call('query', {
  sql: 'SELECT last_updated FROM dashboard_cache'
});

return { screenshot, dbResult };
```

All three steps run in a single `mcp_execute` call.

## Async/await

All server calls return Promises. Always use `await`.

```javascript
try {
  const data = await servers.github.call('search_repositories', {
    query: 'metamcp'
  });
  return data;
} catch (err) {
  console.error('GitHub search failed:', err.message);
  return { error: err.message };
}
```

If you forget `await`, you get a Promise object instead of the result.

## Sleep for polling

Sometimes you need to wait between operations (for example, waiting for a page to load after navigation). Use `sleep(ms)`.

```javascript
await servers.playwright.call('browser_navigate', {
  url: 'https://example.com/slow-page'
});

// Wait 2 seconds for the page to render
await sleep(2000);

const screenshot = await servers.playwright.call('browser_screenshot', {});
return screenshot;
```

Each `sleep()` call is capped at 30,000ms (30 seconds). The total execution timeout is 120,000ms (120 seconds).

## Console output

`console.log`, `console.warn`, `console.error`, `console.info`, and `console.debug` are captured and included in the response. Use them for debugging or returning intermediate results.

```javascript
console.log('Starting workflow...');
const result = await servers.sqlite.call('query', {
  sql: 'SELECT name FROM users LIMIT 5'
});
console.log('Found results');
return result;
```

Console output is prepended to the return value in the response. Output is capped at 10MB total.

## Return values

The last expression or an explicit `return` statement becomes the tool result. Return structured data (objects, arrays) for best results.

```javascript
const users = await servers.sqlite.call('query', {
  sql: 'SELECT * FROM users WHERE active = 1'
});
const count = await servers.sqlite.call('query', {
  sql: 'SELECT count(*) as total FROM users'
});

return {
  activeUsers: users,
  totalCount: count
};
```

If the return value exceeds 10MB when serialized, it is truncated.

## Error handling

Server calls throw regular JavaScript errors on failure. Use try/catch for fallback logic.

```javascript
let result;
try {
  result = await servers.playwright.call('browser_navigate', {
    url: 'https://primary.example.com'
  });
} catch (err) {
  console.warn('Primary failed, trying fallback:', err.message);
  result = await servers.playwright.call('browser_navigate', {
    url: 'https://fallback.example.com'
  });
}
return result;
```

If an error is not caught, `mcp_execute` returns it as an error response with `isError: true`.

## Comparison: mcp_call vs mcp_execute

| Aspect | mcp_call | mcp_execute |
|--------|----------|-------------|
| Round-trips | 1 per call | 1 total |
| Token usage | Higher for multi-step | Lower for multi-step |
| Complexity | Simple, no code needed | Requires JavaScript |
| Use case | Single operations | Multi-step workflows |
| Error handling | LLM decides on retry | try/catch in code |
| Server access | One server per call | All servers in one block |
| Timeout | Per-server | 120 seconds total |

## Sandbox limits

Code submitted to `mcp_execute` runs in a locked-down V8 context. Key limits:

- **Code size:** 50KB max
- **Execution timeout:** 120,000ms (120 seconds)
- **Sleep per call:** 30,000ms (30 seconds) max
- **Output cap:** 10MB for console + return value
- **No access to:** `process`, `require`, `fs`, `fetch`, `Buffer`, `eval`, `Function` constructor

## Next steps

- [Sandbox](/concepts/sandbox) for details on the V8 isolation model
- [Tool Reference](/reference/tool-reference) for complete parameter schemas
