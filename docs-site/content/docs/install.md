---
title: "Installation"
category: "Getting Started"
excerpt: "Install MetaMCP via npx, npm, or from source."
description: "How to install MetaMCP on your system using npx, npm global install, or building from source. Requires Node.js 20 or later."
---

## Prerequisites

MetaMCP requires **Node.js 20 or later**.

Check your version:

```bash
node --version
```

If the output is below `v20.0.0`, upgrade Node.js before continuing. We recommend using [nvm](https://github.com/nvm-sh/nvm) or the official installer at [nodejs.org](https://nodejs.org).

## Run with npx (fastest)

No installation required. Run MetaMCP directly:

```bash
npx metamcp --config .mcp.json
```

This downloads and executes the latest version of MetaMCP. It reads the config file and starts the meta-MCP server on stdio.

> **Tip:** This is the recommended approach for most users. It always runs the latest version and requires no global install.

## Install globally

If you prefer a persistent global install:

```bash
npm install -g metamcp
```

Then run:

```bash
metamcp --config .mcp.json
```

Global install is useful when you run MetaMCP frequently and want to avoid the npx download on each invocation.

## Install from source

Clone the repository and build locally:

```bash
git clone https://github.com/mentu-ai/metamcp.git
cd metamcp
npm ci
npm run build
```

Run the built version:

```bash
node dist/index.js --config .mcp.json
```

Building from source is useful for development or running a specific commit.

## Verify installation

Check that MetaMCP is available and reports the expected version:

```bash
metamcp --version
```

View all available CLI flags:

```bash
metamcp --help
```

If `metamcp` is not found after a global install, ensure your npm global bin directory is in your `PATH`.

## Next steps

- [Quick Start](/quick-start) to create a config file and make your first tool calls.
