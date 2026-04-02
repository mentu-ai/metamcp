---
title: "Contributing"
category: "Reference"
excerpt: "Contribute to MetaMCP development."
description: "Development setup, project structure, commit conventions, and pull request guidelines for contributing to MetaMCP."
---

## Development setup

```bash
git clone https://github.com/mentu-ai/metamcp.git
cd metamcp
npm ci
npm run build
```

Requires Node.js 20 or later.

## Project structure

| File | Description |
|------|-------------|
| `src/index.ts` | CLI entry point, MCP server setup, tool handlers |
| `src/child-manager.ts` | Connection pool, server lifecycle, circuit breaker integration |
| `src/sandbox.ts` | V8 sandbox for `mcp_execute` code execution |
| `src/catalog.ts` | Tool catalog with keyword and semantic search |
| `src/intent.ts` | Intent-based routing (local catalog + registry fallback) |
| `src/config.ts` | `.mcp.json` loader and parser |
| `src/trust.ts` | Trust policy for auto-provisioning decisions |
| `src/types.ts` | Shared types, connection state FSM, pool config |
| `src/mcp-client.ts` | Stdio MCP client wrapper |
| `src/circuit-breaker.ts` | Per-server failure tracking with cooldown |
| `src/registry.ts` | npm registry search with caching and fallback |
| `src/init.ts` | `metamcp init` command, client auto-configuration |
| `src/ledger.ts` | Call audit log (JSON lines) |
| `src/log.ts` | Structured stderr logging |
| `src/embedder.ts` | Text embedding for semantic search |
| `src/vector-store.ts` | Vector storage for tool catalog indexing |
| `src/__tests__/` | Test suites |

## Running tests

```bash
npm test
```

This builds the project and runs the sandbox and child-manager test suites.

## Type checking

```bash
npm run typecheck
```

The project uses TypeScript in strict mode. All code must pass type checking with zero errors.

## Commit convention

MetaMCP uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(sandbox): add memory limit to V8 context
fix(pool): prevent double-eviction on concurrent calls
docs: update CLI options table
test(catalog): add fuzzy search edge cases
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`

**Scopes:** `sandbox`, `pool`, `catalog`, `intent`, `trust`, `config`, `cli`

The type describes the kind of change. The scope (optional) identifies which subsystem is affected.

## Pull request guidelines

- One PR per feature or fix. Keep changes focused.
- All tests must pass (`npm test`).
- Type checking must pass (`npm run typecheck`).
- Describe the "why" in the PR description, not just the "what".
- Avoid unrelated refactors in the same PR.

Branch naming is not enforced, but descriptive names help reviewers: `feat/sandbox-memory-limit`, `fix/pool-double-eviction`.

## Code style

- TypeScript strict mode is enabled.
- No explicit `any` types unless absolutely necessary.
- Prefer `const` over `let`. Never use `var`.
- Error handling follows the pattern: catch, log, re-throw or return typed error.

## Reporting issues

Use [GitHub Issues](https://github.com/mentu-ai/metamcp/issues) with the provided templates. For security vulnerabilities, see [SECURITY.md](https://github.com/mentu-ai/metamcp/blob/main/SECURITY.md).

## License

MetaMCP is licensed under [Apache-2.0](https://github.com/mentu-ai/metamcp/blob/main/LICENSE). All contributions are made under the same license.
