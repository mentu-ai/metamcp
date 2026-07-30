/**
 * Child-Server Era Probe Tests (MCP 2026-07-28)
 *
 * Hand-rolled runner (same pattern as sandbox.test.ts).
 * Import from .js extensions, run from dist/.
 *
 * Test groups:
 * 1. Probe verdicts — modern, legacy, and unreachable servers
 * 2. Era cache — reuse, non-caching of `unknown`, invalidation
 * 3. SDK compatibility — the result schema the real client path requires
 */

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { safeParse } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { probeServerEra, EraCache, PASSTHROUGH_RESULT_SCHEMA, type ProbeableClient } from '../era-probe.js';

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

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** A child that answers server/discover with the given payload. */
function respondingClient(result: unknown): ProbeableClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request<T>(req: { method: string }): Promise<T> {
      calls.push(req.method);
      return result as T;
    },
  };
}

/** A child that rejects server/discover with the given error. */
function failingClient(err: unknown): ProbeableClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request<T>(req: { method: string }): Promise<T> {
      calls.push(req.method);
      throw err;
    },
  };
}

// ─── 1. Probe Verdicts ───────────────────────────────────────────────────────

console.log('Probe Verdicts\n');

await test('a server advertising 2026-07-28 is modern', async () => {
  const r = await probeServerEra(
    respondingClient({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} } })
  );
  assertEqual(r.era, 'modern', 'era');
  assertEqual(r.supportedVersions?.[0], '2026-07-28', 'supportedVersions');
  assert(r.capabilities !== undefined, 'capabilities captured');
});

await test('the probe asks for server/discover', async () => {
  const client = respondingClient({ supportedVersions: ['2026-07-28'] });
  await probeServerEra(client);
  assertEqual(client.calls[0], 'server/discover', 'method');
});

await test('MethodNotFound means the server is legacy', async () => {
  const r = await probeServerEra(failingClient(new McpError(-32601, 'Method not found')));
  assertEqual(r.era, 'legacy', 'era');
});

await test('a bare -32601 error object is also read as legacy', async () => {
  // Not every transport wraps JSON-RPC errors in McpError.
  const r = await probeServerEra(failingClient({ code: -32601, message: 'Method not found' }));
  assertEqual(r.era, 'legacy', 'era');
});

await test('answering with only legacy revisions is legacy, not modern', async () => {
  const r = await probeServerEra(respondingClient({ supportedVersions: ['2025-11-25'] }));
  assertEqual(r.era, 'legacy', 'era');
  assert(r.reason?.includes('modern revision') === true, `expected an explanation, got ${r.reason}`);
});

await test('a future revision beyond 2026-07-28 is still modern', async () => {
  const r = await probeServerEra(respondingClient({ supportedVersions: ['2027-03-01'] }));
  assertEqual(r.era, 'modern', 'era');
});

await test('unknown extra fields do not defeat the probe', async () => {
  const r = await probeServerEra(
    respondingClient({ supportedVersions: ['2026-07-28'], somethingNew: { a: 1 }, instructions: 'hi' })
  );
  assertEqual(r.era, 'modern', 'era');
});

await test('a transport failure yields unknown, not a throw', async () => {
  const r = await probeServerEra(failingClient(new Error('socket hang up')));
  assertEqual(r.era, 'unknown', 'era');
  assert(r.reason?.includes('socket hang up') === true, `reason preserved: ${r.reason}`);
});

await test('a malformed discover result yields unknown', async () => {
  const r = await probeServerEra(respondingClient({ supportedVersions: 'not-an-array' }));
  assertEqual(r.era, 'unknown', 'era');
});

await test('a discover result with no versions is legacy', async () => {
  const r = await probeServerEra(respondingClient({}));
  assertEqual(r.era, 'legacy', 'era');
});

// ─── 2. Era Cache ────────────────────────────────────────────────────────────

console.log('\nEra Cache\n');

await test('resolve probes once and reuses the verdict', async () => {
  const cache = new EraCache();
  const client = respondingClient({ supportedVersions: ['2026-07-28'] });
  await cache.resolve('alpha', client);
  await cache.resolve('alpha', client);
  assertEqual(client.calls.length, 1, 'probed exactly once');
});

await test('unknown verdicts are not cached', async () => {
  const cache = new EraCache();
  const client = failingClient(new Error('timeout'));
  await cache.resolve('flaky', client);
  await cache.resolve('flaky', client);
  // A transient failure must not pin the server to a verdict for the session.
  assertEqual(client.calls.length, 2, 'reprobed after an unknown verdict');
  assertEqual(cache.size, 0, 'nothing cached');
});

await test('legacy verdicts are cached (a server build does not change mid-process)', async () => {
  const cache = new EraCache();
  const client = failingClient(new McpError(-32601, 'Method not found'));
  await cache.resolve('old', client);
  await cache.resolve('old', client);
  assertEqual(client.calls.length, 1, 'probed once');
  assertEqual(cache.get('old')?.era, 'legacy', 'cached verdict');
});

await test('forget re-enables probing for one server', async () => {
  const cache = new EraCache();
  const client = respondingClient({ supportedVersions: ['2026-07-28'] });
  await cache.resolve('beta', client);
  cache.forget('beta');
  await cache.resolve('beta', client);
  assertEqual(client.calls.length, 2, 'reprobed after forget');
});

await test('modernServers lists only the migration-ready children', async () => {
  const cache = new EraCache();
  await cache.resolve('modern-one', respondingClient({ supportedVersions: ['2026-07-28'] }));
  await cache.resolve('modern-two', respondingClient({ supportedVersions: ['2026-07-28'] }));
  await cache.resolve('legacy-one', failingClient(new McpError(-32601, 'nope')));
  await cache.resolve('flaky-one', failingClient(new Error('timeout')));
  const modern = cache.modernServers().sort();
  assertEqual(modern.join(','), 'modern-one,modern-two', 'modern servers');
});

await test('clear empties the cache', async () => {
  const cache = new EraCache();
  await cache.resolve('a', respondingClient({ supportedVersions: ['2026-07-28'] }));
  cache.clear();
  assertEqual(cache.size, 0, 'size');
});

// ─── 3. SDK Compatibility ────────────────────────────────────────────────────

console.log('\nSDK Compatibility\n');

await test('the result schema survives the SDK validation path', () => {
  // Client.request() runs every response through the SDK's zod-compat
  // safeParse() before a caller sees it. The fakes above bypass the real client,
  // so exercise the SDK's own helper directly — an incompatible schema would
  // otherwise only fail against a live child server.
  const payload = { supportedVersions: ['2026-07-28'], somethingUnknown: true };
  const result = safeParse(PASSTHROUGH_RESULT_SCHEMA, payload);
  assertEqual(result.success, true, 'accepted by the SDK validation path');
});

await test('the result schema preserves fields it does not know about', () => {
  // A discover reply may carry extensions we have never heard of; dropping or
  // rejecting them would make an unknown-but-valid server look unreadable.
  const result = safeParse(PASSTHROUGH_RESULT_SCHEMA, {
    supportedVersions: ['2026-07-28'],
    capabilities: { tools: {} },
    someFutureExtension: { enabled: true },
  });
  assert(result.success, 'parsed');
  const data = (result as { success: true; data: Record<string, unknown> }).data;
  assertEqual((data.supportedVersions as string[])[0], '2026-07-28', 'known field');
  assert(data.someFutureExtension !== undefined, 'unknown field preserved');
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
