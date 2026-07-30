import { Worker } from 'node:worker_threads';
import type { ChildManager } from './child-manager.js';
import type { ToolCatalog } from './catalog.js';

const MAX_CODE_SIZE = 50 * 1024;
const EXECUTION_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface SandboxResult {
  value: unknown;
  console: string[];
}

export interface SandboxExecutionOptions {
  timeoutMs?: number;
}

interface WorkerResultMessage {
  type: 'result';
  ok: boolean;
  value?: unknown;
  console: string[];
  message?: string;
}

interface WorkerServerCallMessage {
  type: 'serverCall';
  id: number;
  serverId: string;
  tool: string;
  args?: Record<string, unknown>;
}

type WorkerMessage = WorkerResultMessage | WorkerServerCallMessage;

export async function execute(
  code: string,
  childManager: ChildManager,
  catalog: ToolCatalog,
  options: SandboxExecutionOptions = {},
): Promise<SandboxResult> {
  if (Buffer.byteLength(code, 'utf-8') > MAX_CODE_SIZE) {
    throw new Error(`Code size exceeds limit (${MAX_CODE_SIZE} bytes)`);
  }

  const timeoutMs = Math.max(1, options.timeoutMs ?? EXECUTION_TIMEOUT_MS);

  return new Promise<SandboxResult>((resolve, reject) => {
    const worker = new Worker(new URL('./sandbox-worker.js', import.meta.url), {
      workerData: { code, timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES },
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error('Sandbox error: Execution timeout'));
    }, timeoutMs);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };

    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'serverCall') {
        void handleServerCall(worker, childManager, catalog, message);
        return;
      }

      settle(() => {
        if (!message.ok) {
          reject(new Error(`Sandbox error: ${message.message ?? 'Execution failed'}`));
          return;
        }
        resolve({ value: message.value, console: message.console });
      });
    });

    worker.on('error', err => {
      const message = err instanceof Error ? err.message : String(err);
      settle(() => reject(new Error(`Sandbox error: ${message}`)));
    });

    worker.on('exit', code => {
      if (!settled && code !== 0) {
        settle(() => reject(new Error(`Sandbox error: worker exited with code ${code}`)));
      }
    });
  });
}

async function handleServerCall(
  worker: Worker,
  childManager: ChildManager,
  catalog: ToolCatalog,
  message: WorkerServerCallMessage,
): Promise<void> {
  try {
    const serverTools = catalog.getServerTools(message.serverId);
    if (serverTools.length === 0) {
      await childManager.ensureConnected(message.serverId);
    }
    const value = await childManager.callTool(message.serverId, message.tool, message.args);
    worker.postMessage({
      type: 'serverResult',
      id: message.id,
      ok: true,
      value: makeCloneable(value),
    });
  } catch (err) {
    worker.postMessage({
      type: 'serverResult',
      id: message.id,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function makeCloneable(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
