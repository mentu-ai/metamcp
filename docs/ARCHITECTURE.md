# MetaMCP architecture

MetaMCP 1.0 is an on-demand MCP gateway, not a universal MCP replacement.

## Boundary

The deployment decision is made per server:

1. Keep a server direct when it is foundational, frequently used, compact, strongly authenticated, or carries high-consequence mutations.
2. Put a server behind MetaMCP when it belongs to the irregular long tail and its full schema surface would otherwise occupy client context.
3. Promote repeated multi-call behavior into a reviewed Method when consistency matters more than open-ended composition.

This gives clients a stable assembly language (`mcp_discover`, `mcp_call`) plus a deterministic consistency layer (`mcp_run`). It avoids the false choice between exposing every raw tool and hiding every capability behind an opaque planner.

## Runtime flow

```text
configuration ──► cached catalog ───────────────► mcp_discover
                       │                              │
                       │ no process start             │ explicit refresh(server)
                       ▼                              ▼
MCP client ──► mcp_call / mcp_run ──► target lookup ──► single-flight connect
                                                        │
                                                        ▼
                                                serialized child calls
                                                        │
                                                        ▼
                                              result + ordered ledger append
```

Discovery is static by default. A cold server has state `configured`; a cached catalog does not imply that the child is healthy. A live refresh is scoped to one named server.

Capability search is local and keyword-only by default. Semantic search and its SQLite index are loaded only when the operator explicitly supplies `METAMCP_VOYAGE_API_KEY`; in that mode, discovery queries cross the network to Voyage.

Concurrent first calls share one connection attempt. Calls to an individual child are serialized so the connection state machine remains deterministic. Different children can still run concurrently.

## Failure semantics

MetaMCP never automatically replays a child call after a protocol timeout, closed transport, or child crash. Delivery may have succeeded before the response disappeared.

A Method may define bounded retry or polling only when the step declares `idempotency: "safe"`. This declaration is reviewed configuration, not a guess made from the tool name. A failed step either stops the Method or becomes an explicit typed gap; silent continuation is not supported.

Configuration reload is replace-based. Removed or changed children are disconnected and forgotten; additions become available without spawning. Invalid reloads are rejected and the last valid configuration remains active.

## Security model

MetaMCP assumes each configured child is trusted code. A stdio child executes with the operating-system identity of MetaMCP and can use permissions available to that identity. MetaMCP does not claim that Node.js VM contexts or worker threads form an isolation boundary.

The runtime narrows exposure by:

- removing arbitrary JavaScript execution from the MCP surface;
- never installing packages from a model-facing tool;
- passing a minimal runtime environment to stdio children;
- resolving credentials explicitly per child and failing on missing references;
- disabling write/mixed Methods unless the operator enables them;
- binding HTTP to loopback by default;
- refusing an unauthenticated non-loopback HTTP bind;
- denying browser Origins unless exactly allowlisted;
- scrubbing both text and structured responses before they leave the gateway.

These controls do not replace OS sandboxing, containers, separate service accounts, network policy, package pinning, or client-side human approval.

## Protocol support

The gateway accepts the legacy initialized MCP flow and the MCP 2026-07-28 stateless request envelope on stdio and Streamable HTTP. Child connections are probed before handshake and use either the modern stateless client path or the SDK's legacy client path.

Streamable HTTP remains stateless per request. `/healthz` and protected-resource metadata are unauthenticated by design; the MCP endpoint uses configured OAuth/JWT validation or the shared bearer-token mode. Deployments should terminate TLS before MetaMCP when traffic leaves the host.

## Extension points

The neutral core intentionally has no embedded LLM, package installer, or product-specific skill system. Products can layer these capabilities above it:

- a Mentu extension can compile intent into reviewed Method manifests;
- Crawlio can expose native higher-order browser Methods or serve as a child;
- a host application can install a keychain-backed `SecretProvider`;
- an organization can generate Methods from its own policy-controlled catalog.

Extensions should not silently widen the three-tool core or treat unreviewed generated code as a security boundary.
