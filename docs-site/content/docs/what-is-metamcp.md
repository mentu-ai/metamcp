---
title: "What is MetaMCP?"
category: "Getting Started"
excerpt: "MetaMCP is a meta-MCP server that collapses N child servers into 4 tools."
description: "Learn how MetaMCP reduces token overhead by sitting in front of multiple MCP servers and exposing just 4 meta-tools to the LLM."
---

## Overview

MetaMCP is a meta-MCP server. It sits in front of N child MCP servers and exposes exactly 4 tools to the LLM: `mcp_discover`, `mcp_provision`, `mcp_call`, and `mcp_execute`.

Instead of registering every tool from every child server directly with the LLM, MetaMCP acts as a single gateway. The LLM discovers tools on demand, calls them through MetaMCP, and composes multi-step workflows in a V8 sandbox.

MetaMCP manages the full lifecycle of child server connections: spawning, pooling, health monitoring, and graceful shutdown. The LLM never interacts with child servers directly.

## The problem

Every MCP server registers its tool schemas with the LLM. Each schema consumes context tokens.

The math adds up fast. A typical setup might include:

| Servers | Tools per server | Total schemas | Estimated tokens |
|---------|-----------------|---------------|-----------------|
| 2       | 15              | 30            | ~4,500          |
| 5       | 20              | 100           | ~15,000         |
| 10      | 25              | 250           | ~37,500         |

At 5 servers with 20 tools each, you spend roughly 15,000 tokens on schema definitions alone. Every request pays this cost, even when the LLM only needs one tool from one server.

Large schema sets also degrade tool selection accuracy. The LLM must scan through hundreds of tool descriptions to find the right one. More schemas means more ambiguity and slower reasoning.

## How MetaMCP solves it

MetaMCP collapses all child servers into 4 meta-tools. Regardless of how many child servers you run, or how many tools they expose, the LLM sees exactly 4 tool schemas.

The schema cost drops to roughly 1,000 tokens. That number stays constant whether you have 3 child servers or 30.

Here is how the 4 tools work together:

1. **`mcp_discover`** searches tool catalogs across all child servers using hybrid search (semantic + keyword). The LLM finds the right tool without needing every schema in context.
2. **`mcp_provision`** handles intent-based provisioning. Describe what you need, and MetaMCP resolves and provisions the right server, including auto-installing from npm if needed.
3. **`mcp_call`** forwards a single tool call to a specific child server. MetaMCP handles connection management and retries on crash.
4. **`mcp_execute`** runs JavaScript in a V8 sandbox with access to all provisioned servers. This enables multi-step workflows, loops, and conditional logic in a single call.

For a detailed breakdown of each tool, see [The Four Tools](/concepts/the-four-tools).

## Architecture diagram

```text
                    ┌─── playwright (52 tools)
                    │
LLM ──► MetaMCP ────┼─── fetch (3 tools)
        (4 tools)   │
                    ├─── sqlite (6 tools)
                    │
                    └─── ... N more servers
```

The LLM communicates with MetaMCP over stdio. MetaMCP communicates with each child server over stdio. All connections are managed by a bounded connection pool.

## Key capabilities

- **Connection pool with LIFO eviction.** Bounded pool of child server connections. Least-recently-used connections are evicted first when the pool is full.
- **Lazy spawning.** Child servers start only when first needed, not at boot time.
- **Circuit breaker.** Per-server failure isolation. After repeated failures, a server is temporarily removed from the pool to prevent cascading errors.
- **V8 sandbox.** Code-mode execution lets the LLM compose multi-step workflows in JavaScript with `async/await`, `sleep(ms)`, and `console.log`.
- **Hybrid search.** Tool discovery combines semantic similarity and keyword matching for accurate results across large catalogs.
- **npm registry integration.** Auto-provisioning can install MCP servers from npm on demand.

## When to use MetaMCP

MetaMCP is a good fit when:

- **You run 3 or more MCP servers.** The token savings become meaningful at this threshold. The more servers you add, the greater the benefit.
- **You want to reduce token overhead.** Constant 4-schema cost instead of linear growth with each new server.
- **You need a single connection point.** One MCP server for the LLM to connect to, regardless of how many child servers exist behind it.
- **You want code-mode composition.** Multi-step workflows that call multiple servers, handle errors, and return structured results in a single LLM turn.

MetaMCP adds a layer of indirection. If you only use one or two MCP servers, the overhead may not be worth the token savings.

## Next steps

- [Installation](/install) to get MetaMCP running on your system.
- [Quick Start](/quick-start) for a hands-on walkthrough.
- [Architecture](/concepts/architecture) for a deeper look at connection pooling, circuit breakers, and shutdown behavior.
