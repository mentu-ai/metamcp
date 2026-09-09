# MetaMCP v1.0.1

A patch release. No tool surface, Method Mode, transport, or configuration
behavior changes; 1.0.0 configurations keep working unchanged.

## Fixed

- **The `apistatuscheck-mcp-server` gallery entry provisioned a server that
  could not start.** The published npm tarball ships `dist/index.js` without a
  shebang or exec bit, so `npx` handed the ESM bundle to `sh`, which resolved
  `import` to ImageMagick and exited 0 without ever speaking MCP. The entry now
  targets the maintained Streamable HTTP endpoint at
  `https://apistatuscheck.com/api/mcp` directly. Reported and first fixed by
  @shibley in [#2](https://github.com/mentu-ai/metamcp/pull/2).

## Changed

- **Gallery entries can be hosted endpoints.** `GalleryEntry` carries either a
  local launcher (`command` + `args`) or a hosted endpoint (`url`, optional
  `transportType`), never both. `metamcp add` writes hosted entries to
  `.mcp.json` as native remote servers, the same shape `loadConfig` already
  accepts, and `metamcp add --list` marks them 🌐. The gallery never routes a
  remote server through a stdio bridge package such as `mcp-remote`; a test
  enforces it.
- `CONTRIBUTING.md` states the inbound license a contributor grants.
- Transitive `fast-uri`, `hono` and `qs` bumped in the lockfile to clear
  `npm audit`. No dependency ranges changed.

## Verification

- Full suite, smoke test and release contract pass; CI and CodeQL green on
  `main`.
- Live through the gateway: `metamcp add apistatuscheck`, then `mcp_discover`
  reports the server with an `http` transport and
  `mcp_call apistatuscheck.list_down_apis` returns current data.

## Upgrade

```bash
npx @mentu/metamcp@1.0.1 tools --json
```
