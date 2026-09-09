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

This builds the project and runs unit, protocol, security, and end-to-end suites.

## Type Checking

```bash
npm run typecheck
```

## Project Structure

```
src/
  index.ts             # CLI, transports, exact three-tool MCP surface
  methods.ts           # Declarative Method registry and bounded runtime
  child-manager.ts     # Lazy connections, serialization, circuit breaker
  config.ts            # Validated .mcp.json loader and secret references
  config-imports.ts    # Explicit editor-config discovery
  catalog.ts           # Cached child schemas and local keyword search
  schema-cache.ts      # Durable schema cache
  gateway-auth.ts      # Inbound HTTP authorization policy
  resource-auth.ts     # OAuth protected-resource validation
  ledger.ts            # Ordered call and Method audit log
  evidence-export.ts   # Portable hash-linked evidence bundles
  init.ts              # Preview-first client configuration
  gallery.ts           # Human-operated optional server gallery
  __tests__/           # Unit, protocol, security, and E2E suites
```

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(methods): add bounded status polling
fix(pool): prevent double-eviction on concurrent calls
docs: update CLI options table
test(catalog): add fuzzy search edge cases
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`

**Scopes:** `methods`, `pool`, `catalog`, `transport`, `config`, `cli`, `security`

## Pull Request Guidelines

- One PR per feature or fix
- All tests must pass (`npm test`)
- Type checking must pass (`npm run typecheck`)
- Describe the "why" in the PR description, not just the "what"
- Keep changes focused - avoid unrelated refactors in the same PR

## Reporting Issues

Use [GitHub Issues](https://github.com/mentu-ai/metamcp/issues) with the provided templates. For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

By submitting a contribution you grant Mentu a perpetual, worldwide,
non-exclusive, irrevocable, royalty-free license to use, reproduce, modify,
prepare derivative works of, publicly display, distribute, sublicense and
relicense your contribution and any derivative works, including under
commercial terms and under licenses other than the one in this repository.

You confirm that you wrote the contribution yourself, or otherwise have the
right to grant this license, and that it does not knowingly include third-party
code you are not permitted to submit.

Your contribution reaches everyone else under the license in this repository
(Apache License 2.0). You keep the copyright in what you wrote.
