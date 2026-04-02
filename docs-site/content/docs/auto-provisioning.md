---
title: "Auto-Provisioning"
category: "Guides"
excerpt: "Let MetaMCP find and install MCP servers automatically."
description: "How MetaMCP resolves intents to MCP servers, evaluates trust, and auto-provisions packages from the npm registry."
---

## How it works

When you call `mcp_provision` with an intent like "I need to crawl a website", MetaMCP resolves the right server for you. It searches local catalogs first, then the npm registry. If a match is found and passes the trust policy, MetaMCP can auto-install and configure the server.

```json
{
  "name": "mcp_provision",
  "arguments": {
    "intent": "I need to crawl a website and extract links",
    "autoProvision": true
  }
}
```

## Intent resolution order

Resolution follows a strict sequence:

1. **Local catalog search.** MetaMCP checks all pre-configured and already-connected servers for tools matching your intent. If any match scores at or above 0.5 confidence, the local results are returned immediately.

2. **Registry fallback.** If no local match exceeds the 0.5 confidence threshold, MetaMCP searches the npm registry for MCP server packages.

3. **Trust evaluation.** Registry matches are evaluated against the trust policy (see below). Only packages that pass both gates can be auto-provisioned.

4. **Provision or recommend.** If `autoProvision: true` and the package is trusted, MetaMCP installs it. Otherwise, it returns the recommendation for you to install manually.

## Trust policy

Auto-provisioning is gated by two independent checks. Both must pass.

### Namespace allowlist

The package must belong to a trusted namespace. MetaMCP reads the allowlist from `~/.metamcp/trusted-servers.json`. This file contains an array of namespace patterns.

Default trusted namespaces (created by `initializeDefault()`):

```json
[
  "@modelcontextprotocol/*",
  "@anthropic/*"
]
```

Patterns ending in `/*` match the entire scope. For example, `@modelcontextprotocol/*` trusts any package under that npm scope.

To trust additional namespaces, edit `~/.metamcp/trusted-servers.json`:

```json
[
  "@modelcontextprotocol/*",
  "@anthropic/*",
  "@playwright/*",
  "@stripe/*"
]
```

### Confidence threshold

The semantic similarity between your intent and the package description must meet or exceed **0.9** (90%). This threshold is intentionally high. A malicious package can game keyword matching, so namespace trust alone is not sufficient, and high confidence alone is not sufficient either.

The confidence score is computed by matching words from your intent against the package name and description. Exact name matches score highest, partial name matches score moderately, and description keyword matches score lowest.

## Registry cache

Results from the npm registry are cached locally at `~/.metamcp/registry-cache.json`. The cache refreshes every **24 hours** (86,400,000ms). This avoids repeated network requests for the same search.

If the registry API is unreachable, MetaMCP falls back to the cache. If the cache is also unavailable, it uses a bundled list of 20 well-known MCP servers from organizations like `@modelcontextprotocol`, `@anthropic`, `@playwright`, `@stripe`, and `@sentry`.

## Manual provisioning

If auto-provisioning is disabled (the default) or the package does not meet trust requirements, `mcp_provision` returns the recommendation without installing anything.

```json
{
  "source": "registry",
  "matches": [
    {
      "name": "@playwright/mcp",
      "description": "Browser automation with Playwright",
      "confidence": 0.85,
      "installCommand": "npx -y @playwright/mcp"
    }
  ]
}
```

You can then manually add the server to your `.mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

See [Adding Servers](/guides/adding-servers) for the full walkthrough.

## Next steps

- [Adding Servers](/guides/adding-servers) for manual configuration
- [Discovery](/concepts/discovery) for how tool search works across servers
