# Contributing to MetaMCP

Thank you for your interest in contributing to MetaMCP.

## Development Setup

```bash
git clone https://github.com/mentu-ai/metamcp.git
cd metamcp
npm ci
npm run build
```

## Running Tests

```bash
npm test
```

This builds the project and runs the sandbox and child-manager test suites.

## Type Checking

```bash
npm run typecheck
```

## Project Structure

```
src/
  index.ts          # CLI entry point, MCP server, tool handlers
  child-manager.ts  # Connection pool, lifecycle, circuit breaker
  sandbox.ts        # V8 sandbox for mcp_execute
  catalog.ts        # Tool catalog with keyword search
  intent.ts         # Intent-based routing (local + registry)
  config.ts         # .mcp.json loader
  trust.ts          # Trust policy for auto-provisioning
  types.ts          # Shared types, FSM, pool config
  mcp-client.ts     # stdio MCP client wrapper
  circuit-breaker.ts
  registry.ts       # npm registry search
  ledger.ts         # Call audit log
  log.ts            # Structured stderr logging
  __tests__/        # Test suites
```

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(sandbox): add memory limit to V8 context
fix(pool): prevent double-eviction on concurrent calls
docs: update CLI options table
test(catalog): add fuzzy search edge cases
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`

**Scopes:** `sandbox`, `pool`, `catalog`, `intent`, `trust`, `config`, `cli`

## Pull Request Guidelines

- One PR per feature or fix
- All tests must pass (`npm test`)
- Type checking must pass (`npm run typecheck`)
- Describe the "why" in the PR description, not just the "what"
- Keep changes focused — avoid unrelated refactors in the same PR

## Reporting Issues

Use [GitHub Issues](https://github.com/mentu-ai/metamcp/issues) with the provided templates. For security vulnerabilities, see [SECURITY.md](SECURITY.md).
