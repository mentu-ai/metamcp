---
title: "Connection Pool"
category: "Concepts"
excerpt: "Connection pooling for MCP child servers."
description: "How MetaMCP manages a pool of child MCP server connections with lazy spawning, LIFO idle lists, and configurable bounds."
---

## Why a Pool?

MCP servers are stdio processes. Starting and stopping them is expensive. Each spawn involves process creation, initialization handshakes, and tool catalog fetches.

Without a pool, every tool call would potentially require spawning a new process, waiting for it to initialize, making the call, and then deciding whether to keep it around. The connection pool solves this by keeping frequently-used servers warm and ready.

The pool manages the full lifecycle: spawning on first use, tracking idle connections, evicting stale ones, and enforcing concurrency limits.

## Pool Configuration

Configure the pool through `metamcp.config.json` under the `pool` key, or via CLI flags.

| Field | Type | Default | CLI Flag | Description |
|-------|------|---------|----------|-------------|
| `poolSize` | number | 20 | `--pool-size` | Max concurrent child connections |
| `resPoolSize` | number | 0 | `--res-pool-size` | Reserve slots above poolSize |
| `minPoolSize` | number | 0 | `--min-pool-size` | Minimum connections to keep alive |
| `resPoolTimeout` | number | 5000 | `--res-pool-timeout` | Milliseconds before reserve activates |
| `idleTimeoutMs` | number | 300000 | `--idle-timeout` | Idle connection timeout (ms) |
| `failureThreshold` | number | 5 | `--failure-threshold` | Circuit breaker trips after N failures |
| `cooldownMs` | number | 30000 | `--cooldown` | Circuit breaker cooldown (ms) |

**Example configuration:**

```json
{
  "pool": {
    "poolSize": 30,
    "minPoolSize": 3,
    "idleTimeoutMs": 600000
  }
}
```

## Lazy Spawning

Child servers start on first use, not at boot. MetaMCP does not pre-spawn any servers when it launches.

When `mcp_discover`, `mcp_call`, or `mcp_execute` needs a server, the pool checks if that server is already running. If not, it spawns the child process, completes the MCP handshake, fetches the tool catalog, and then forwards the request.

This keeps startup time fast. A MetaMCP instance with 50 configured servers boots in milliseconds because zero child processes start until something actually needs them.

## LIFO Idle List

When a connection becomes idle (no active requests), it moves to the HEAD of the idle list. Eviction removes from the TAIL (the oldest idle connection).

This LIFO (Last-In, First-Out) ordering means recently-used connections stay warm. If the pool needs to evict a connection to make room, it removes the one that has been idle the longest, not the one most recently used.

The result: servers you use frequently stay running. Servers you used once an hour ago get cleaned up first.

## Idle Timeout

Connections idle longer than `idleTimeoutMs` (default: 300,000ms, or 5 minutes) are eligible for cleanup.

The pool runs a periodic sweep to find and close expired idle connections. The sweep interval is 60 seconds (`SWEEP_INTERVAL_MS = 60_000` from `child-manager.ts`). During each sweep, any connection whose idle time exceeds the threshold is gracefully shut down.

> **Tip:** For development workloads with long pauses between interactions, increase `idleTimeoutMs` to avoid respawning servers repeatedly. For production with many servers, a shorter timeout frees resources faster.

Override via CLI:

```bash
metamcp --idle-timeout 600000
```

## Pool Bounds

The pool enforces strict concurrency limits.

**Upper bound:** The pool never exceeds `poolSize` active connections. The absolute maximum is `poolSize + resPoolSize`. Reserve slots only activate after `resPoolTimeout` milliseconds, acting as burst capacity for temporary spikes.

**Eviction under pressure:** When the pool is full and a new server is needed, the oldest idle connection is evicted first. If there are no idle connections available to evict, the request waits until a slot opens.

**Minimum guard:** The `minPoolSize` setting prevents the pool from evicting connections below a minimum count. If `minPoolSize` is 3 and only 3 connections remain, none will be evicted by idle timeout or pressure eviction.

> **Note:** The `minPoolSize` guard applies to total active connections, not per-server. It ensures a baseline number of servers stay warm, but does not guarantee which specific servers are retained.

## Next Steps

- [Circuit Breaker](/concepts/circuit-breaker) for fault tolerance when child servers crash
- [Architecture](/concepts/architecture) for how the pool fits into the overall system
