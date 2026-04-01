/**
 * Store<K, V> Unit Tests
 *
 * Hand-rolled runner (same pattern as child-manager.test.ts).
 * 11 test cases covering: lazy-load, cache hit, TTL, retention window,
 * cleanup timer, stopCleanup, loader error, disposer, destroy,
 * connection pooling pattern, catalog caching pattern.
 */

import { Store } from '../store.js';

// ─── Test Runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.log('Store<K, V> Tests\n');

  // 1. Lazy-load: get() calls loader on cache miss
  await test('1. Lazy-load: get() calls loader on cache miss', async () => {
    let loadCount = 0;
    const store = new Store<string, number>({
      loader: async (key) => { loadCount++; return key.length; },
    });
    const val = await store.get('hello');
    assertEqual(val, 5, 'value');
    assertEqual(loadCount, 1, 'loader called once');
    store.destroy();
  });

  // 2. Cache hit: get() returns cached value without calling loader again
  await test('2. Cache hit: returns cached, no second load', async () => {
    let loadCount = 0;
    const store = new Store<string, number>({
      loader: async (key) => { loadCount++; return key.length; },
    });
    await store.get('abc');
    await store.get('abc');
    assertEqual(loadCount, 1, 'loader called only once');
    assertEqual(store.size, 1, 'single entry');
    store.destroy();
  });

  // 3. TTL expiration: entry is evicted after TTL elapses
  await test('3. TTL expiration: evicted after TTL', async () => {
    const disposed: string[] = [];
    const store = new Store<string, string>({
      loader: async (key) => `val-${key}`,
      disposer: (key) => disposed.push(key),
      defaultTtlMs: 50,
    });
    await store.get('a');
    assertEqual(store.has('a'), true, 'cached initially');
    store.startCleanup(20);
    await delay(120);
    assertEqual(store.has('a'), false, 'evicted after TTL');
    assert(disposed.includes('a'), 'disposer called for evicted key');
    store.destroy();
  });

  // 4. Retention window: entry is evicted if not accessed within window
  await test('4. Retention window: evicted when stale', async () => {
    const disposed: string[] = [];
    const store = new Store<string, string>({
      loader: async (key) => `val-${key}`,
      disposer: (key) => disposed.push(key),
      retentionWindowMs: 50,
    });
    await store.get('b');
    assertEqual(store.has('b'), true, 'cached initially');
    store.startCleanup(20);
    await delay(120);
    assertEqual(store.has('b'), false, 'evicted after retention window');
    assert(disposed.includes('b'), 'disposer called');
    store.destroy();
  });

  // 5. Cleanup timer: periodic cleanup runs and evicts stale entries
  await test('5. Cleanup timer: periodic eviction works', async () => {
    let loadCount = 0;
    const store = new Store<string, number>({
      loader: async () => { loadCount++; return 42; },
      defaultTtlMs: 30,
    });
    await store.get('x');
    assertEqual(store.size, 1, 'one entry');
    store.startCleanup(15);
    await delay(100);
    assertEqual(store.size, 0, 'entry evicted by cleanup');
    await store.get('x');
    assertEqual(loadCount, 2, 'loader called twice (re-loaded after eviction)');
    store.destroy();
  });

  // 6. stopCleanup: timer is properly cancelled
  await test('6. stopCleanup: timer cancelled, no further eviction', async () => {
    const store = new Store<string, string>({
      loader: async (key) => key,
      defaultTtlMs: 30,
    });
    await store.get('keep');
    store.startCleanup(15);
    store.stopCleanup();
    await delay(100);
    // Entry is expired by TTL but cleanup isn't running to evict it
    assertEqual(store.has('keep'), true, 'entry retained (cleanup stopped)');
    store.destroy();
  });

  // 7. Loader error: failed load does not corrupt cache (subsequent get retries)
  await test('7. Loader error: cache not corrupted, retry works', async () => {
    let callCount = 0;
    const store = new Store<string, number>({
      loader: async () => {
        callCount++;
        if (callCount === 1) throw new Error('first call fails');
        return 99;
      },
    });
    let threw = false;
    try { await store.get('key'); } catch { threw = true; }
    assert(threw, 'first get threw');
    assertEqual(store.has('key'), false, 'not cached after error');
    const val = await store.get('key');
    assertEqual(val, 99, 'retry succeeded');
    assertEqual(store.has('key'), true, 'cached after success');
    store.destroy();
  });

  // 8. Disposer: called on eviction with correct key and value
  await test('8. Disposer: called with correct key and value', async () => {
    const disposals: Array<{ key: string; value: number }> = [];
    const store = new Store<string, number>({
      loader: async (key) => key.length * 10,
      disposer: (key, value) => disposals.push({ key, value }),
    });
    await store.get('ab');
    await store.get('cde');
    store.delete('ab');
    assertEqual(disposals.length, 1, 'one disposal');
    assertEqual(disposals[0].key, 'ab', 'disposed key');
    assertEqual(disposals[0].value, 20, 'disposed value');
    store.destroy();
    assertEqual(disposals.length, 2, 'two disposals after destroy');
    assertEqual(disposals[1].key, 'cde', 'second disposed key');
    assertEqual(disposals[1].value, 30, 'second disposed value');
  });

  // 9. destroy(): stops cleanup and disposes all entries
  await test('9. destroy: stops cleanup and disposes all', async () => {
    const disposed: string[] = [];
    const store = new Store<string, string>({
      loader: async (key) => `v-${key}`,
      disposer: (key) => disposed.push(key),
    });
    await store.get('x');
    await store.get('y');
    await store.get('z');
    store.startCleanup(100);
    store.destroy();
    assertEqual(store.size, 0, 'cache cleared');
    assertEqual(disposed.length, 3, 'all entries disposed');
    assert(disposed.includes('x') && disposed.includes('y') && disposed.includes('z'), 'all keys disposed');
  });

  // 10. Connection pooling: child-manager Store spawns on miss, evicts idle
  await test('10. Connection pooling: spawn on miss, evict idle', async () => {
    const spawned: string[] = [];
    const cleaned: string[] = [];
    const store = new Store<string, { name: string; state: string }>({
      loader: async (name) => {
        spawned.push(name);
        return { name, state: 'ACTIVE' };
      },
      disposer: (name, child) => {
        child.state = 'CLOSED';
        cleaned.push(name);
      },
      retentionWindowMs: 40,
    });
    store.startCleanup(15);
    const child = await store.get('server-a');
    assertEqual(child.state, 'ACTIVE', 'spawned active');
    assertEqual(spawned.length, 1, 'one spawn');
    store.touch('server-a');
    await delay(100);
    assertEqual(store.has('server-a'), false, 'evicted after idle');
    assert(cleaned.includes('server-a'), 'disposer ran on eviction');
    store.destroy();
  });

  // 11. Catalog caching: Store loads tools on miss, refreshes after TTL
  await test('11. Catalog caching: load on miss, refresh after TTL', async () => {
    let loadVersion = 0;
    const store = new Store<string, string[]>({
      loader: async (server) => {
        loadVersion++;
        return [`${server}-tool-v${loadVersion}`];
      },
      defaultTtlMs: 40,
    });
    store.startCleanup(15);
    const tools1 = await store.get('server-a');
    assertEqual(tools1[0], 'server-a-tool-v1', 'first load version');
    const tools2 = await store.get('server-a');
    assertEqual(tools2[0], 'server-a-tool-v1', 'cache hit same version');
    assertEqual(loadVersion, 1, 'loader called once');
    await delay(100);
    assertEqual(store.has('server-a'), false, 'evicted after TTL');
    const tools3 = await store.get('server-a');
    assertEqual(tools3[0], 'server-a-tool-v2', 'refreshed version');
    assertEqual(loadVersion, 2, 'loader called twice');
    store.destroy();
  });

  // ─── Results ───────────────────────────────────────────────────────────────

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
