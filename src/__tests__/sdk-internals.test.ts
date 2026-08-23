/**
 * SDK Internals Shape Guard
 *
 * Hand-rolled test runner.
 * Import from .js extensions, run from dist/.
 *
 * McpClient.closeStdin() ends the child's stdin to shut a server down
 * gracefully. The SDK exposes only `pid` and `stderr` publicly, so that path
 * reads the private `_process` field of StdioClientTransport.
 *
 * If an SDK upgrade renames that field, closeStdin() silently returns false
 * and every child gets SIGTERM'd instead of a clean EOF — a real behaviour
 * change with no failing test and no error. These tests pin the coupling so
 * the rename fails here instead.
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveChildProcess } from '../mcp-client.js';

// ─── Test Runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  FAIL: ${name} — ${msg}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

// ─── Shape Guard ─────────────────────────────────────────────────────────────

console.log('SDK Internals Shape Guard\n');

/** Spawns an idle child, runs the check, and always tears the child down. */
async function withStartedTransport(fn: (t: StdioClientTransport) => void): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  });
  await transport.start();
  try {
    fn(transport);
  } finally {
    await transport.close();
  }
}

await test('StdioClientTransport still exposes pid publicly', async () => {
  await withStartedTransport((transport) => {
    assert(typeof transport.pid === 'number', `expected numeric pid, got ${typeof transport.pid}`);
  });
});

await test('resolveChildProcess finds the child behind a started transport', async () => {
  await withStartedTransport((transport) => {
    const proc = resolveChildProcess(transport);
    assert(
      proc !== null,
      'SDK internal `_process` no longer resolves — closeStdin() would silently ' +
        'degrade to signal-only shutdown. Re-point resolveChildProcess() in mcp-client.ts ' +
        'at the new field, or switch to a public API if the SDK gained one.'
    );
  });
});

await test('resolved child process has a writable stdin', async () => {
  await withStartedTransport((transport) => {
    const proc = resolveChildProcess(transport);
    assert(proc?.stdin != null, 'child process has no stdin — graceful EOF shutdown is impossible');
  });
});

await test('resolveChildProcess returns null for a transport with no child', async () => {
  assert(resolveChildProcess(null) === null, 'null transport should resolve to null');
  assert(resolveChildProcess({}) === null, 'shapeless transport should resolve to null');
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
}
