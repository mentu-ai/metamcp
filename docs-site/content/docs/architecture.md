---
title: "Architecture"
category: "Concepts"
excerpt: "How MetaMCP manages connections, pools, catalogs, and shutdown."
description: "Deep dive into MetaMCP's architecture, including the connection state machine, pool configuration, catalog building, and graceful shutdown behavior."
---

## System overview

MetaMCP sits between the LLM and N child MCP servers. It acts as a single MCP server from the LLM's perspective, exposing 4 meta-tools instead of the combined tool set of all child servers.

```text
                    ┌─── playwright (52 tools)
                    │
LLM ──► MetaMCP ────┼─── fetch (3 tools)
        (4 tools)   │
                    ├─── sqlite (6 tools)
                    │
                    └─── ... N more servers
```

The LLM communicates with MetaMCP over stdio. MetaMCP communicates with each child server over stdio. Each child server runs as a separate process spawned and managed by MetaMCP.

MetaMCP never exposes child server tools directly. All interactions flow through the 4 meta-tools: `mcp_discover` for search, `mcp_provision` for setup, `mcp_call` for invocation, and `mcp_execute` for multi-step code workflows.

## Connection state machine

Each child server connection follows a 5-state lifecycle. The state machine governs when connections can be used, retried, or discarded.

| State        | Value          | Description                        | Valid transitions                     |
|--------------|----------------|------------------------------------|---------------------------------------|
| IDLE         | `'idle'`       | Ready for use.                     | CONNECTING, ACTIVE, CLOSED            |
| CONNECTING   | `'connecting'` | Handshake in progress.             | ACTIVE, FAILED, CLOSED               |
| ACTIVE       | `'active'`     | Processing a request.              | IDLE, FAILED, CLOSED                  |
| FAILED       | `'failed'`     | Circuit breaker tripped.           | CONNECTING, CLOSED                    |
| CLOSED       | `'closed'`     | Deallocated. Terminal state.       | None (no transitions out)             |

A connection starts in IDLE or CONNECTING (for lazy-spawned servers). On a successful handshake, it transitions to ACTIVE when processing a request, then back to IDLE when done.

If a request fails, the connection transitions to FAILED. After the circuit breaker cooldown expires, it can attempt to reconnect (FAILED to CONNECTING). If the server is shut down or evicted, the connection moves to CLOSED, which is terminal.

> **Note:** The CLOSED state is irreversible. Once a connection is closed, MetaMCP will spawn a new process if that server is needed again.

## Pool architecture

MetaMCP manages child server connections through a bounded connection pool. The pool prevents unbounded resource usage and provides backpressure when many servers are in use.

### Pool configuration defaults

| Parameter          | Default   | Description                                          |
|--------------------|-----------|------------------------------------------------------|
| `poolSize`         | `20`      | Maximum concurrent child server connections.         |
| `resPoolSize`      | `0`       | Reserve connections above `poolSize`.                |
| `minPoolSize`      | `0`       | Minimum connections to keep alive.                   |
| `resPoolTimeout`   | `5000`    | Milliseconds before reserve pool activates.          |
| `idleTimeoutMs`    | `300000`  | Idle connection timeout (5 minutes).                 |
| `failureThreshold` | `5`       | Failures before circuit breaker trips.               |
| `cooldownMs`       | `30000`   | Circuit breaker cooldown (30 seconds).               |

### Bounded pool

The `poolSize` parameter sets the hard limit on concurrent connections. When the pool is full and a new connection is needed, MetaMCP evicts the least recently used idle connection.

### Reserve pool

The `resPoolSize` parameter adds capacity above the main pool. Reserve connections activate only after `resPoolTimeout` milliseconds of waiting, providing a buffer for burst traffic without permanently increasing the pool size.

With the default `resPoolSize` of 0, the reserve pool is disabled.

### Minimum connections

The `minPoolSize` parameter keeps a minimum number of connections alive. These connections are not subject to idle timeout eviction. This is useful for critical servers that must respond quickly.

With the default `minPoolSize` of 0, all idle connections are eligible for eviction.

### LIFO idle list

Idle connections are stored in a LIFO (last-in, first-out) stack. When a connection is returned to the pool, it goes to the top. When a connection is needed, the most recently used one is taken from the top.

LIFO ordering keeps recently active connections warm, reducing the chance of using a stale connection that may have timed out at the OS level.

### Idle timeout sweep

A periodic sweep checks for connections that have been idle longer than `idleTimeoutMs`. These connections are closed and their server processes terminated. The sweep respects `minPoolSize`, keeping at least that many connections alive.

## Catalog building

MetaMCP builds a tool catalog on first use, not at startup.

When `mcp_discover` is called for the first time (or when a server is first accessed), MetaMCP connects to the server, performs the MCP handshake, and calls `tools/list` to retrieve the server's tool definitions. The response is cached in memory.

Subsequent `mcp_discover` calls search the cached catalog without reconnecting to child servers. The catalog is indexed for hybrid search: both semantic similarity and keyword matching are used to rank results.

If a server's connection is evicted and later re-established, MetaMCP refreshes the catalog for that server.

For details on how discovery and search work, see [Discovery](/concepts/discovery).

## Graceful shutdown

MetaMCP handles `SIGINT` and `SIGTERM` signals for clean shutdown.

The shutdown sequence:

1. **Guard activation.** A `shuttingDown` flag prevents re-entrant shutdown if multiple signals arrive.
2. **Drain active connections.** MetaMCP waits for in-progress requests to complete.
3. **Escalating termination.** Child server processes receive progressively more aggressive signals on a timer sequence: 50ms, 100ms, 200ms, 400ms, 800ms delays between escalation steps.
4. **Force kill.** If a child server has not exited after the escalation sequence (approximately 1,550ms total), MetaMCP sends `SIGKILL`.

This progression ensures well-behaved servers have time to clean up, while misbehaving servers are forcefully terminated within a predictable time window.

> **Tip:** If you observe child server processes lingering after MetaMCP exits, it may indicate the child server does not handle `SIGTERM` properly. Check the child server's documentation for shutdown behavior.

## Next steps

- [Connection Pool](/concepts/connection-pool) for advanced pool tuning and monitoring.
- [Circuit Breaker](/concepts/circuit-breaker) for failure isolation patterns.
- [The Four Tools](/concepts/the-four-tools) for how the meta-tools interact with the architecture.
