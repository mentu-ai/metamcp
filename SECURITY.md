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

- **Child process injection or credential leakage** through configuration, arguments, environment inheritance, or response handling
- **Gateway authorization bypass** in OAuth/JWT, shared-token, Origin, or bind-address enforcement
- **Method policy bypass** including unsafe template traversal, unbounded execution, write-effect bypass, or retrying a non-idempotent step
- **Connection lifecycle corruption** including duplicate child spawn, stale configuration use, or implicit replay after uncertain delivery
- **Protocol confusion** between legacy and modern MCP request paths

## Out of Scope

- Vulnerabilities in child MCP servers themselves (report those to the respective projects)
- Denial of service via legitimate heavy usage (resource limits are configurable via CLI flags)

## Security boundary

Configured child MCP servers are trusted code. MetaMCP does not sandbox a child's operating-system access. Use containers, separate users/service accounts, network policy, and scoped credentials when isolation is required.

MetaMCP 1.0 removed the model-facing arbitrary JavaScript executor. Reports about a way to re-enable or remotely reach code execution through the three-tool surface are in scope.

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | Yes       |
