---
title: "Circuit Breaker"
category: "Concepts"
excerpt: "Circuit breaker pattern for child server resilience."
description: "How MetaMCP uses per-server circuit breakers to detect repeated failures and temporarily disable crashing child servers."
---

## Purpose

If a child server crashes repeatedly, MetaMCP stops trying. The circuit breaker tracks consecutive failures per server and temporarily disables servers that exceed the failure threshold.

This prevents a broken server from consuming resources, slowing down requests, and generating noise. Once the cooldown period expires, MetaMCP probes the server again to see if it has recovered.

## How It Works

The circuit breaker (implemented in `src/circuit-breaker.ts`) manages two effective states using a `tripped` boolean:

**Normal (tripped = false).** Requests pass through to the child server. On each failure, a counter increments. When the counter reaches the configured threshold, the breaker sets `tripped = true`, records the timestamp, and resets the counter.

**Open (tripped = true, within cooldown).** Requests are rejected immediately without contacting the child server. The LLM receives an error indicating the server is temporarily unavailable.

**After cooldown expires.** The `isOpen()` check returns false, allowing a single probe request through. If that probe succeeds, `recordSuccess()` resets the breaker to normal. If it fails, the breaker trips again.

## Configuration

| Parameter | Default | CLI Flag | Description |
|-----------|---------|----------|-------------|
| `failureThreshold` | 5 | `--failure-threshold` | Consecutive failures before tripping |
| `cooldownMs` | 30000 | `--cooldown` | Cooldown period in milliseconds |

**Example:**

```json
{
  "pool": {
    "failureThreshold": 3,
    "cooldownMs": 60000
  }
}
```

This trips after 3 consecutive failures and waits 60 seconds before allowing a probe.

## State Transitions

The breaker moves through states in a predictable cycle:

```
normal --[failures reach threshold]--> open
open   --[cooldown expires]----------> probe
probe  --[success]-------------------> normal
probe  --[failure]-------------------> open
```

1. **Normal to Open.** Consecutive failures accumulate. When they reach `failureThreshold`, the breaker trips.
2. **Open to Probe.** After `cooldownMs` elapses, `isOpen()` returns false. The next request acts as a probe.
3. **Probe to Normal.** If the probe request succeeds, `recordSuccess()` resets the `tripped` flag and clears the failure counter.
4. **Probe to Open.** If the probe request fails, the breaker trips again immediately with a fresh cooldown timer.

## Per-Server Isolation

Each child server has its own circuit breaker instance. A failing `sqlite` server does not affect the `playwright` server.

This isolation means one misbehaving server cannot cascade failures across the system. The LLM can continue using healthy servers while a broken one is in cooldown.

## Interaction with Retry

In the `callTool` function (`child-manager.ts`), vital servers or servers with `restartCount < 1` get one automatic retry before a failure is recorded against the circuit breaker.

The retry sequence:

1. First attempt fails.
2. MetaMCP respawns the child process.
3. Second attempt is made against the fresh process.
4. If the second attempt also fails, the circuit breaker records the failure.

This prevents transient errors (a server crash on a single unlucky request) from incrementing the failure counter too quickly. A server must fail twice in a row, including on a fresh process, before the breaker counts it.

> **Note:** The retry only applies to servers marked as vital or those that have not yet been restarted. Non-vital servers that have already been restarted once do not get the automatic retry.

## Next Steps

- [Connection Pool](/concepts/connection-pool) for how server lifecycles are managed
- [Adding Servers](/guides/adding-servers) for configuring child servers
