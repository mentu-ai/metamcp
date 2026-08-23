# Migration to MetaMCP 1.0

MetaMCP 1.0 intentionally narrows the model-facing surface from six tools to three. This is a security and product-boundary change, not a rename-only release.

## Tool changes

| 0.x tool | 1.0 replacement |
|---|---|
| `mcp_discover` | Retained; now static/cached by default and never fans out implicitly |
| `mcp_call` | Retained; target starts lazily and calls are not automatically replayed |
| `mcp_execute` | Removed; author a reviewed declarative Method and call `mcp_run` |
| `mcp_provision` | Removed from MCP; use the human-operated `metamcp add` CLI |
| `mcp_skill_discover` | Remove from prompts or provide a product-specific extension |
| `mcp_skill_advise` | Remove from prompts or provide a product-specific extension |

Calls to removed names fail closed. There is no unsafe compatibility flag for JavaScript execution.

## Decide what stays direct

Do not put every existing connection behind MetaMCP during migration. Keep foundational and frequently used MCPs direct, especially:

- native application connectors with compact typed surfaces;
- identity, billing, infrastructure, deployment, and source-control mutation tools;
- runtimes or browsers used in most sessions;
- servers whose native OAuth or approval UX would be weakened by proxying.

Move irregular long-tail servers first. Measure whether their schemas materially affect context and whether explicit `server`/`tool` routing remains understandable.

## Replace code mode

Convert stable `mcp_execute` programs into Method manifests:

1. Turn external inputs into `inputSchema` fields.
2. Convert each child call into a named step.
3. Replace data access with `${input...}` and `${steps...}` references.
4. Replace catch-and-ignore behavior with `onError: "gap"` where partial evidence is legitimate.
5. Declare `effects` and enable writes only at operator startup.
6. Use bounded `poll` for status checks and bounded `retry` only for safe steps.
7. Add `outputSchema` before consumers depend on the result.

Open-ended loops, dynamic code generation, filesystem access, and arbitrary network calls do not belong in a Method. Put such logic in a reviewed child MCP server with an appropriately narrow tool.

## Environment inheritance

0.x copied the MetaMCP process environment into every stdio child. 1.0 passes only a small runtime allowlist.

For each child:

- put scoped credentials in its `env` block, preferably as `${ENV_REFERENCE}`;
- list non-secret parent variables that must be inherited in `inheritEnv`;
- do not use `inheritEnv` as a blanket secret pass-through.

Ambient `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` values no longer activate semantic discovery. Keyword search is the local default; set the dedicated `METAMCP_VOYAGE_API_KEY` only when sending discovery queries to Voyage is intended.

Unresolved `${ENV_REFERENCE}` values now fail config loading instead of reaching the child literally.

## HTTP deployments

The default host changed from `0.0.0.0` to `127.0.0.1`.

For a remote deployment, explicitly set the bind host and configure OAuth/JWT validation or `METAMCP_HTTP_BEARER_TOKEN`. An open non-loopback listener will refuse to start. Browser callers must also be listed with `--allow-origin` or `METAMCP_ALLOWED_ORIGINS`.

## Setup command

`metamcp init` is now a dry-run. Review the plan, then apply it:

```bash
metamcp init
metamcp init --client Codex --yes
```

It no longer creates configs for every known client. Invalid JSON is never replaced.

## Operational checks

After migration:

1. Confirm `tools/list` returns exactly `mcp_discover`, `mcp_call`, and `mcp_run`.
2. Call discovery and verify cold children remain `configured` rather than starting.
3. Refresh one server explicitly and inspect its live schemas.
4. Exercise each Method's success, typed-gap, and deadline paths.
5. Simulate a child crash after a test mutation and verify there is no replay.
6. Verify non-loopback HTTP refuses to start without auth.
7. Export and verify an evidence bundle.
