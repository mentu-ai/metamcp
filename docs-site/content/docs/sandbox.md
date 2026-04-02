---
title: "V8 Sandbox"
category: "Concepts"
excerpt: "Isolated V8 sandbox for code-mode execution."
description: "How MetaMCP sandboxes mcp_execute code in a locked-down V8 context with sealed prototypes, no I/O, and injected server APIs."
---

## What Is Code Mode?

`mcp_execute` runs user-provided JavaScript in a V8 sandbox. It lets the LLM compose multi-step workflows across servers in a single tool call, saving round-trips and tokens.

Instead of four separate `mcp_call` invocations (four round-trips to the LLM), a single `mcp_execute` call handles the entire workflow in one shot. The sandbox provides the necessary APIs to call server tools while blocking everything else.

For usage patterns and examples, see [Code Mode](/guides/code-mode).

## V8 Context Lockdown

The sandbox runs in a Node.js `vm.Context` with a deny-all default posture.

- `Object.create(null)` as the context base blocks `__proto__` traversal.
- `codeGeneration.strings: false` disables `eval()` and `new Function()`.
- `codeGeneration.wasm: false` disables WebAssembly compilation.
- Strict mode is enforced on all executed code.

No network, filesystem, or process APIs exist in the context. The sandbox starts empty and only the explicitly allowed globals are added.

## Allowed Globals

The following globals are available inside the sandbox (from `ALLOWED_GLOBALS` in `src/sandbox.ts`):

| Global | Purpose |
|--------|---------|
| `JSON` | JSON parsing and serialization |
| `Math` | Mathematical operations |
| `Date` | Date and time |
| `Array`, `Map`, `Set` | Data structures |
| `Promise` | Async operations |
| `Object`, `String`, `Number`, `Boolean` | Primitives |
| `RegExp` | Regular expressions |
| `Error`, `TypeError`, `RangeError`, `SyntaxError`, `URIError` | Error types |
| `parseInt`, `parseFloat`, `isNaN`, `isFinite` | Number parsing |
| `encodeURIComponent`, `decodeURIComponent`, `encodeURI`, `decodeURI` | URI encoding |
| `undefined`, `NaN`, `Infinity` | Constants |
| `console` | Output capture |
| `setTimeout`, `clearTimeout` | Timer support |

## Injected APIs

Three APIs are injected into the sandbox context beyond the standard globals:

### servers

A proxy object for calling provisioned server tools.

```js
const result = await servers.sqlite.call('query', { sql: 'SELECT 1' });
```

`servers.<name>.call(tool, args)` returns a Promise. Any server that has been provisioned (via `mcp_provision` or previously used via `mcp_call`) is accessible. Backpressure is handled naturally through async/await.

### sleep(ms)

Pause execution for a specified duration.

```js
await sleep(2000); // wait 2 seconds
```

Maximum sleep per call is 30,000ms (`MAX_SLEEP_MS`). Calls exceeding this limit are clamped.

### console.log / warn / error / info / debug

Output is captured and returned in the tool response.

```js
console.log('Step 1 complete');
console.log('Found', results.length, 'items');
```

Output is capped at 10MB (`MAX_OUTPUT_BYTES`). All console methods are captured, not just `log`.

## Protection Vectors

The sandbox applies 15 protection layers (from `src/sandbox.ts`):

1. `Object.prototype` sealed (prevents prototype pollution, existing properties still writable)
2. `Array.prototype` sealed
3. `Function.prototype` frozen (blocks `constructor.constructor` escape)
4. Async function prototype frozen
5. Generator function prototype frozen
6. `eval()` disabled (throws `EvalError` via `codeGeneration.strings: false`)
7. `new Function()` disabled (same mechanism)
8. No `require` or `import` (not present in sandbox context)
9. No `process`, `fs`, `Buffer`, `fetch`, `global`, `globalThis`
10. No `__dirname`, `__filename`
11. No `SharedArrayBuffer` (deleted after context creation)
12. No `WebAssembly` (deleted after context creation)
13. `Object.create(null)` context (blocks `__proto__` traversal)
14. Strict mode enforced (blocks `arguments.callee.caller`)
15. `Error.prepareStackTrace` overridden (prevents stack trace leaks)

## Limits

| Limit | Value | Source Constant |
|-------|-------|-----------------|
| Max code size | 50 KB | `MAX_CODE_SIZE = 50 * 1024` |
| Execution timeout | 120 seconds | `EXECUTION_TIMEOUT_MS = 120_000` |
| Max sleep per call | 30 seconds | `MAX_SLEEP_MS = 30_000` |
| Max output size | 10 MB | `MAX_OUTPUT_BYTES = 10 * 1024 * 1024` |

> **Warning:** Code that exceeds the execution timeout is terminated. There is no graceful shutdown. Design workflows to complete well within the 120-second limit.

## What You CAN Do

- Async/await for sequencing operations
- Call server tools via the `servers` proxy
- Use `sleep()` for pacing requests
- Capture output with `console.log`
- Standard JavaScript: math, strings, arrays, objects, JSON, RegExp, Date
- Error handling with try/catch
- Loops, conditionals, and all standard control flow

## What You CANNOT Do

- File system access (no `fs`, `readFile`, `writeFile`)
- Network requests (no `fetch`, `http`, `XMLHttpRequest`)
- Module imports (no `require`, `import`)
- Process spawning (no `child_process`, `exec`)
- Environment variable access (no `process.env`)
- Prototype modification (sealed/frozen prototypes)
- Dynamic code generation (no `eval`, `new Function()`)
- WebAssembly compilation

## Next Steps

- [Code Mode](/guides/code-mode) for practical usage patterns and examples
- [The Four Tools](/concepts/the-four-tools) for how `mcp_execute` fits alongside the other tools
