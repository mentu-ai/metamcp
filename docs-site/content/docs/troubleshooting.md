---
title: "Troubleshooting"
category: "Reference"
excerpt: "Diagnose and fix common MetaMCP issues."
description: "Solutions for common MetaMCP problems including server failures, circuit breakers, timeouts, and connection issues."
---

## Server won't start

The child server process fails to launch or connect.

**Check these first:**
- The command exists in your PATH (run `which <command>` to verify).
- Arguments are correct and in the right order.
- The binary has execute permissions (`chmod +x /path/to/binary`).
- For npx packages, ensure Node.js 20+ is installed.

**Diagnostic:** Run `mcp_discover` with no arguments to see server status. A server stuck in `"connecting"` or `"failed"` state indicates a launch problem.

## Circuit breaker tripped

A server has failed 5 consecutive times (the default threshold) and MetaMCP has stopped sending requests to it.

**What happens:** The circuit breaker enters an open state. All calls to that server return an error immediately: `Circuit breaker open for <server> — cooldown 30000ms`.

**How to resolve:**
- Wait for the cooldown period (30,000ms / 30 seconds by default) to elapse. The circuit breaker resets automatically after the cooldown.
- Restart MetaMCP to reset all circuit breakers immediately.
- If the server keeps failing, fix the underlying issue (bad config, missing dependency, crashed process).

**Adjusting thresholds:** Use `--failure-threshold` to change how many failures trigger the breaker, and `--cooldown` to change the recovery period.

```bash
metamcp --config .mcp.json --failure-threshold 3 --cooldown 60000
```

## Tool not found

The tool name or server name in `mcp_call` does not match any known tool.

**Possible causes:**
- Typo in the server name or tool name.
- The server has not been spawned yet (lazy spawning connects on first use).
- The server is in a failed state and its tools are not registered.

**How to resolve:** Use `mcp_discover` with the server name to list its tools and verify the exact names.

```json
{ "server": "playwright", "query": "navigate" }
```

## Code execution timeout

`mcp_execute` has a total execution timeout of 120,000ms (120 seconds). If your code takes longer, it is terminated.

**Common causes:**
- A child server call is hanging (the server process is unresponsive).
- Too many sequential operations in a single execution.
- A `sleep()` call that is too long (each call is capped at 30,000ms).

**How to resolve:**
- Break the workflow into smaller `mcp_execute` calls.
- Check if the child server is responsive by calling it directly with `mcp_call`.
- Reduce sleep durations.

## Connection refused

The child server process crashed or was killed after it was initially connected.

**What happens:** MetaMCP will attempt to respawn the server on the next call. Vital servers (the default criticality) get one automatic retry. If the respawn also fails, the error is returned to the caller.

**How to resolve:**
- Check if the server has resource constraints (memory, file handles).
- Look at MetaMCP's stderr output for spawn error messages.
- Try running the server command manually to see its error output.

## Pool exhaustion

All connection slots are in use. The default pool size is 20 concurrent child servers.

**Error message:** `Pool upper bound (20) reached, no idle children to evict`

**How to resolve:**
- Reduce the number of concurrent servers in your config.
- Increase the pool size: `--max-connections 50`.
- Reduce idle timeout so unused servers are cleaned up faster: `--idle-timeout 60000`.

## Environment variables not loaded

Environment variables set in the `env` field of a server entry are passed to that child server's process only. They are not available to MetaMCP itself or to other servers.

**Common mistakes:**
- Putting env vars in the wrong server entry.
- Setting env vars in the MCP client config (e.g., Claude Desktop) instead of in the MetaMCP `.mcp.json`.
- Using variable references (like `$HOME`) in env values. MetaMCP passes values as literal strings.

## Diagnostic commands

| Command | What it shows |
|---------|---------------|
| `mcp_discover` (no args) | All servers with state, tool count, and criticality |
| `mcp_discover` with `server` | Status and tools for one specific server |
| `mcp_discover` with `query` | Tools matching a search term across all servers |
| `mcp_provision` with `intent` | Whether a capability is available locally or in the registry |

## FAQ

**Can I reload the config without restarting MetaMCP?**
No. Config is loaded once at startup. To pick up changes, restart MetaMCP.

**Why does the first call to a server take longer?**
MetaMCP uses lazy spawning. Child servers start on first use, not at boot. The first call includes the time to launch the process and complete the MCP handshake.

**Can I use MetaMCP with non-stdio MCP servers?**
Currently, MetaMCP only supports MCP servers that communicate over stdio. SSE and HTTP transports are not yet supported.

**How do I see MetaMCP's logs?**
MetaMCP writes structured JSON logs to stderr. Redirect stderr to a file to capture them: `metamcp --config .mcp.json 2>metamcp.log`.
