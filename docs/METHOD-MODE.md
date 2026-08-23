# Method Mode

Method Mode is MetaMCP's deterministic consistency layer. A Method is a versioned JSON manifest that composes child MCP tools without arbitrary code.

Raw tools optimize for coverage and high variance. Direct calls optimize for explicit assembly. Methods optimize for repeatability: the same validated inputs follow the same bounded call graph and return the same evidence shape.

The design follows a behavioral protocol:

1. **Acquire** — collect source facts or state.
2. **Normalize** — turn heterogeneous child results into a stable contract.
3. **Analyze** — derive or verify conclusions from normalized evidence.

A Method does not need all three phases, but it must not analyze data that it has not acquired and normalized into an explicit step result.

## Manifest contract

Every manifest has:

- `apiVersion: metamcp.io/v1alpha1` and `kind: Method`;
- a stable name and version;
- input and optional output JSON Schemas;
- an effect declaration: `read`, `write`, or `mixed`;
- one to 64 ordered steps;
- optional overall/step deadlines and output limits;
- an optional output template.

Each step names a configured `server` and child `tool`. `args` and `output` may reference:

- `${input.field}`
- `${steps.step_id.structuredContent.field}`
- `${steps.step_id.content.0.text}`
- `${steps.step_id.gap.code}` after `onError: "gap"`

An exact reference preserves the referenced JSON type. A reference embedded inside a longer string is stringified. Prototype-related path components are rejected.

Steps run in manifest order. `dependsOn` documents and validates that dependencies refer to earlier steps; v1alpha1 does not execute a parallel DAG.

## Errors and gaps

`onError` accepts two policies:

- `fail` (default) stops the Method.
- `gap` records a closed `step_failed` gap and continues.

There is no silent `continue` mode. Raw child errors are not copied into the durable gap because they may contain credentials, URLs, or unbounded prose. The trace retains the step, server, tool, status, attempt count, and duration.

The Method result is:

```json
{
  "method": "content.acquire-and-normalize",
  "version": "1.0.0",
  "status": "completed_with_gaps",
  "output": {},
  "gaps": [
    {
      "code": "step_failed",
      "step": "optional_metadata",
      "server": "content",
      "tool": "metadata",
      "message": "Child tool call failed"
    }
  ],
  "trace": []
}
```

Consumers must inspect both `status` and `gaps`; the presence of an output object is not proof of completeness.

## Retry and polling

MetaMCP never retries an ordinary call automatically. A Method step can opt into bounded transport retry:

```json
{
  "id": "read_status",
  "server": "jobs",
  "tool": "get_status",
  "idempotency": "safe",
  "retry": { "maxAttempts": 2, "backoffMs": 250 }
}
```

It can also replace improvised model-side polling with an explicit predicate:

```json
{
  "id": "wait",
  "server": "jobs",
  "tool": "get_status",
  "idempotency": "safe",
  "poll": {
    "path": "structuredContent.state",
    "equals": "complete",
    "maxAttempts": 20,
    "intervalMs": 1000
  }
}
```

Retry and polling require `idempotency: "safe"`; manifests that omit it are rejected. Both remain inside the Method's overall deadline. Write timeouts are never assumed safe.

## Effects and approval

Read Methods run by default. Write and mixed Methods require the gateway operator to pass `--allow-writes` or set `METAMCP_ALLOW_WRITES=1`. This is an operator deployment policy, not a claim that a model-supplied boolean constitutes human approval.

High-consequence actions should generally stay on a direct MCP whose client presents native approvals. If a write Method is justified, keep the effect obvious, use the narrowest child credentials, and design idempotency at the underlying API.

## Authoring workflow

1. Start with direct `mcp_discover` and `mcp_call` while the workflow is still exploratory.
2. Record the repeated steps, input/output shapes, failure cases, and evidence gaps.
3. Write a manifest and validate it against [`method-v1alpha1.schema.json`](../schemas/method-v1alpha1.schema.json).
4. Test it with fixture children, including timeout, gap, retry, polling, and output-limit cases.
5. Review its effect and credential boundary.
6. Version the Method when behavior or output contracts change.

Do not hide a high-variance task inside a giant Method. Keep the direct assembly language available for investigation, then promote only the stable ritual.

The general model is informed by [Crawlio's Method Mode](https://docs.crawlio.app/mcp/method-mode?utm_source=github&utm_medium=docs&utm_campaign=mcp-setup&utm_content=metamcp-method-mode&utm_term=method-mode), where higher-order browser methods replace manual polling, normalization, and evidence improvisation.
