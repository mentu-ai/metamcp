import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

const MAX_SLEEP_MS = 30_000;

const ALLOWED_GLOBALS = [
  'JSON', 'Math', 'Date', 'Array', 'Map', 'Set', 'Promise',
  'Object', 'String', 'Number', 'Boolean', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'URIError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI',
  'undefined', 'NaN', 'Infinity',
  'console',
] as const;

interface WorkerData {
  code: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface ServerResultMessage {
  type: 'serverResult';
  id: number;
  ok: boolean;
  value?: unknown;
  message?: string;
}

const data = workerData as WorkerData;
const consoleLines: string[] = [];
const pendingServerCalls = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}>();
let nextServerCallId = 1;

parentPort?.on('message', (message: ServerResultMessage) => {
  if (message.type !== 'serverResult') return;
  const pending = pendingServerCalls.get(message.id);
  if (!pending) return;
  pendingServerCalls.delete(message.id);
  if (message.ok) {
    pending.resolve(message.value);
  } else {
    pending.reject(new Error(message.message ?? 'server call failed'));
  }
});

void run();

async function run(): Promise<void> {
  try {
    const ctx = buildContext();
    const script = new vm.Script(`'use strict'; (async () => { ${data.code} })()`, {
      filename: 'mcp_execute',
    });
    const value = await script.runInContext(ctx, { timeout: data.timeoutMs });
    postResult({ ok: true, value: capResult(value) });
  } catch (err) {
    postResult({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function buildContext(): vm.Context {
  const sandbox: Record<string, unknown> = Object.create(null);

  for (const name of ALLOWED_GLOBALS) {
    if (name in globalThis) {
      sandbox[name] = (globalThis as Record<string, unknown>)[name];
    }
  }

  sandbox.console = buildConsole();
  sandbox.sleep = (ms: number): Promise<void> => {
    const capped = Math.min(Math.max(0, ms), MAX_SLEEP_MS);
    return new Promise(resolve => setTimeout(resolve, capped));
  };
  sandbox.servers = buildServersProxy();

  const ctx = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  vm.runInContext(`(function() {
    Error.prepareStackTrace = undefined;
    delete this.SharedArrayBuffer;
    delete this.WebAssembly;
  })();`, ctx, { timeout: data.timeoutMs });

  return ctx;
}

function buildConsole(): Record<string, unknown> {
  let consoleBytes = 0;
  let consoleTruncated = false;
  const pushLine = (line: string): void => {
    if (consoleTruncated) return;
    const lineBytes = Buffer.byteLength(line, 'utf-8');
    if (consoleBytes + lineBytes > data.maxOutputBytes) {
      consoleLines.push('[output truncated]');
      consoleTruncated = true;
      return;
    }
    consoleBytes += lineBytes;
    consoleLines.push(line);
  };

  const capturedConsole: Record<string, unknown> = Object.create(null);
  capturedConsole.log = (...args: unknown[]) => pushLine(args.map(String).join(' '));
  capturedConsole.warn = (...args: unknown[]) => pushLine(`[warn] ${args.map(String).join(' ')}`);
  capturedConsole.error = (...args: unknown[]) => pushLine(`[error] ${args.map(String).join(' ')}`);
  capturedConsole.info = (...args: unknown[]) => pushLine(`[info] ${args.map(String).join(' ')}`);
  capturedConsole.debug = (...args: unknown[]) => pushLine(`[debug] ${args.map(String).join(' ')}`);
  return capturedConsole;
}

function buildServersProxy(): unknown {
  return new Proxy(Object.create(null), {
    get(_: unknown, serverId: string) {
      return Object.freeze({
        call: async (tool: string, args?: Record<string, unknown>) => callServer(serverId, tool, args),
      });
    },
  });
}

function callServer(serverId: string, tool: string, args?: Record<string, unknown>): Promise<unknown> {
  const id = nextServerCallId++;
  return new Promise((resolve, reject) => {
    pendingServerCalls.set(id, { resolve, reject });
    parentPort?.postMessage({ type: 'serverCall', id, serverId, tool, args });
  });
}

function capResult(value: unknown): unknown {
  if (value === undefined) return value;
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, 'utf-8') > data.maxOutputBytes) {
      return `${serialized.slice(0, data.maxOutputBytes)}... [result truncated]`;
    }
  } catch {
    return String(value);
  }
  return value;
}

function postResult(payload: { ok: boolean; value?: unknown; message?: string }): void {
  parentPort?.postMessage({
    type: 'result',
    ok: payload.ok,
    value: payload.value,
    message: payload.message,
    console: consoleLines,
  });
}
