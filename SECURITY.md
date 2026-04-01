# Security Policy

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/mentu-ai/metamcp/security/advisories/new).

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and provide a timeline for a fix.

## Scope

MetaMCP has a security-sensitive architecture. The following areas are in scope:

- **V8 sandbox escape** — any code that breaks out of the `mcp_execute` sandbox (`vm.Context` isolation, prototype freezing, `eval`/`Function` constructor blocking)
- **Child process injection** — command injection via `.mcp.json` config entries, argument manipulation, or environment variable leakage
- **Trust policy bypass** — circumventing the trust evaluation for auto-provisioning npm registry packages
- **Connection pool state corruption** — manipulating the circuit breaker, idle sweep, or pool bounds to cause denial of service

## Out of Scope

- Vulnerabilities in child MCP servers themselves (report those to the respective projects)
- Denial of service via legitimate heavy usage (resource limits are configurable via CLI flags)

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | Yes       |
