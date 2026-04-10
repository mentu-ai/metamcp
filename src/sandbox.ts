import vm from 'node:vm';
import type { ChildManager } from './child-manager.js';
import type { ToolCatalog } from './catalog.js';

const MAX_CODE_SIZE = 50 * 1024; // 50KB
const EXECUTION_TIMEOUT_MS = 120_000; // 120s
const MAX_SLEEP_MS = 30_000; // 30s per sleep() call
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB output cap

/**
 * V8 Context Lockdown.
 *
 * Sandbox follows a deny-all default with explicit injection:
 *   - Whitelist safe globals (no require, process, fs, fetch, Buffer)
 *   - Inject only: servers Proxy, sleep(), console (captured)
 *   - Enforce timeout via vm.Script timeout
 */
const ALLOWED_GLOBALS = [
  'JSON', 'Math', 'Date', 'Array', 'Map', 'Set', 'Promise',
  'Object', 'String', 'Number', 'Boolean', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'URIError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI',
  'undefined', 'NaN', 'Infinity',
  'console',
  'setTimeout', 'clearTimeout',
] as const;

/**
 * Freeze shared prototypes once on first sandbox use.
 *
 * Node.js vm module shares built-in prototypes (Object.prototype, Array.prototype,
 * Function.prototype) between host and sandbox contexts. We freeze them once to
 * prevent any sandbox code from polluting the host via prototype modification.
 *
 * IMPORTANT: This runs at first execute() call, NOT at module import time.
 * This ensures all dependencies (MCP SDK, Zod, etc.) have completed initialization
 * before we lock down prototypes. The freeze is irreversible and permanent.
 */
let prototypesLocked = false;
function lockPrototypes(): void {
  if (prototypesLocked) return;
  prototypesLocked = true;

  // Seal Object.prototype — prevents adding new properties (prototype pollution)
  // but keeps existing properties writable (libraries can still shadow toString, etc.)
  Object.seal(Object.prototype);
  Object.seal(Array.prototype);

  // Freeze Function.prototype — blocks constructor.constructor escape
  // Also freeze async/generator function prototypes
  Object.freeze(Function.prototype);
  Object.freeze(Object.getPrototypeOf(async function(){}).constructor.prototype);
  Object.freeze(Object.getPrototypeOf(function*(){}).constructor.prototype);
}

export interface SandboxResult {
  value: unknown;
  console: string[];
}

/**
 * Build a locked-down V8 context.
 *
 * Pattern: Object.create(null) blocks __proto__ traversal.
 * Strict mode enforced by wrapping code in async IIFE with 'use strict'.
 *
 * Escape vector mitigations:
 * - Function.prototype frozen → blocks constructor.constructor
 * - Object.prototype sealed → blocks prototype pollution
 * - Object.create(null) context → blocks __proto__ traversal
 * - Strict mode → blocks arguments.callee.caller
 * - eval/Function disabled via codeGeneration.strings:false (throws EvalError)
 * - SharedArrayBuffer/WebAssembly deleted from context after creation
 * - Error.prepareStackTrace overridden
 */
function buildContext(
  childManager: ChildManager,
  catalog: ToolCatalog,
  consoleLines: string[],
): vm.Context {
  // Start with null-prototype object (blocks __proto__ traversal)
  const sandbox: Record<string, unknown> = Object.create(null);

  // Copy allowed globals from the real global
  for (const name of ALLOWED_GLOBALS) {
    if (name in globalThis) {
      sandbox[name] = (globalThis as Record<string, unknown>)[name];
    }
  }

  // Captured console — 5 methods: debug, info, log, warn, error
  // Output capped at MAX_OUTPUT_BYTES to prevent unbounded memory growth.
  let consoleBytes = 0;
  let consoleTruncated = false;
  const pushLine = (line: string): void => {
    if (consoleTruncated) return;
    const lineBytes = Buffer.byteLength(line, 'utf-8');
    if (consoleBytes + lineBytes > MAX_OUTPUT_BYTES) {
      consoleLines.push('[output truncated]');
      consoleTruncated = true;
      return;
    }
    consoleBytes += lineBytes;
    consoleLines.push(line);
  };
  const capturedConsole: Record<string, unknown> = Object.create(null);
  capturedConsole['log'] =
    (...args: unknown[]) => pushLine(args.map(String).join(' '));
  capturedConsole['warn'] =
    (...args: unknown[]) => pushLine(`[warn] ${args.map(String).join(' ')}`);
  capturedConsole['error'] =
    (...args: unknown[]) => pushLine(`[error] ${args.map(String).join(' ')}`);
  capturedConsole['info'] =
    (...args: unknown[]) => pushLine(`[info] ${args.map(String).join(' ')}`);
  capturedConsole['debug'] =
    (...args: unknown[]) => pushLine(`[debug] ${args.map(String).join(' ')}`);
  sandbox['console'] = capturedConsole;

  // sleep() function capped at 30s per call
  sandbox['sleep'] = (ms: number): Promise<void> => {
    const capped = Math.min(Math.max(0, ms), MAX_SLEEP_MS);
    return new Promise(resolve => setTimeout(resolve, capped));
  };

  /**
   * Host-Guest Bridge — JS Proxy pattern.
   *
   * The ONLY way guest code reaches external services. Each server access
   * returns a frozen object with a single `call(tool, args)` method.
   *
   * Backpressure is handled naturally: if a child server is slow, the
   * Promise blocks the guest code. No explicit flag management needed
   * in async JS.
   */
  sandbox['servers'] = new Proxy(Object.create(null), {
    get(_: unknown, serverId: string) {
      return Object.freeze({
        call: async (tool: string, args?: Record<string, unknown>) => {
          const serverTools = catalog.getServerTools(serverId);
          if (serverTools.length === 0) {
            await childManager.ensureConnected(serverId);
          }
          return await childManager.callTool(serverId, tool, args);
        },
      });
    },
  });

  // Timer support for async patterns
  sandbox['setTimeout'] = setTimeout;
  sandbox['clearTimeout'] = clearTimeout;

  // Explicitly do NOT include dangerous globals:
  // process, require, module, exports, Buffer, __dirname, __filename,
  // eval, Function (as constructor), SharedArrayBuffer, WebAssembly,
  // global, globalThis
  // These are simply not copied into the sandbox.

  // Create the V8 context with code generation disabled
  // codeGeneration.strings: false → eval() and new Function() throw EvalError
  // codeGeneration.wasm: false → WebAssembly.compile() throws CompileError
  // eval() and new Function() disabled — throws EvalError
  const ctx = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  // Clean up V8 auto-injected globals and harden the context.
  // vm.createContext installs built-in constructors (SharedArrayBuffer,
  // WebAssembly, etc.) that we must strip for sandbox isolation.
  vm.runInContext(`(function() {
    Error.prepareStackTrace = undefined;
    delete this.SharedArrayBuffer;
    delete this.WebAssembly;
  })();`, ctx);

  return ctx;
}

/**
 * Execute user code in a sandboxed V8 context.
 *
 * Execution flow:
 * 1. Validate code size (<= 50KB)
 * 2. Lock shared prototypes (once, on first call)
 * 3. Create sandboxed context with only allowed globals + servers proxy + sleep + console
 * 4. Wrap code in async IIFE with 'use strict'
 * 5. Compile as vm.Script
 * 6. Execute with 120s timeout
 * 7. Capture return value + console output
 * 8. Return combined result
 */
export async function execute(
  code: string,
  childManager: ChildManager,
  catalog: ToolCatalog,
): Promise<SandboxResult> {
  // Step 1: Validate code size
  if (Buffer.byteLength(code, 'utf-8') > MAX_CODE_SIZE) {
    throw new Error(`Code size exceeds limit (${MAX_CODE_SIZE} bytes)`);
  }

  // Step 2: Lock shared prototypes (idempotent — only runs once)
  lockPrototypes();

  // Step 3: Create sandboxed context
  const consoleLines: string[] = [];
  const ctx = buildContext(childManager, catalog, consoleLines);

  // Step 4: Wrap in async IIFE with strict mode
  const wrapped = `'use strict'; (async () => { ${code} })()`;

  // Step 5: Compile as vm.Script
  const script = new vm.Script(wrapped, {
    filename: 'mcp_execute',
  });

  // Step 6: Execute with timeout
  // vm.Script.runInContext timeout covers synchronous execution.
  // For async code, we race the promise against a timeout.
  let value: unknown;
  try {
    const promise = script.runInContext(ctx, { timeout: EXECUTION_TIMEOUT_MS });

    // Race against timeout for the async portion
    value = await Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Execution timeout')), EXECUTION_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    // Re-throw with sanitized message (no host paths/stack traces)
    if (err instanceof Error) {
      throw new Error(`Sandbox error: ${err.message}`);
    }
    throw new Error(`Sandbox error: ${String(err)}`);
  }

  // Step 7-8: Cap result value size and return
  if (value !== undefined) {
    try {
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized, 'utf-8') > MAX_OUTPUT_BYTES) {
        value = serialized.slice(0, MAX_OUTPUT_BYTES) + '... [result truncated]';
      }
    } catch {
      // Non-serializable value — leave as-is
    }
  }
  return { value, console: consoleLines };
}
