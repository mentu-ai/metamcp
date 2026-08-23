import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCacheStale, readSchemaCache, writeSchemaCache } from '../schema-cache.js';
import type { ToolDefinition } from '../types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL: ${name} - ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function tool(name: string, type: string): ToolDefinition {
  return {
    name,
    server: 'fixture',
    description: 'fixture tool',
    inputSchema: { type: 'object', properties: { value: { type } } },
  };
}

console.log('Schema Cache Tests\n');

test('tool ordering does not invalidate an equivalent cache', () => {
  const first = tool('first', 'string');
  const second = tool('second', 'number');
  assert(!isCacheStale([first, second], [second, first]), 'equivalent reordered tools are stale');
});

test('input schema changes invalidate the cache', () => {
  assert(isCacheStale([tool('read', 'string')], [tool('read', 'number')]), 'schema change was ignored');
});

test('cache reads and writes honor an isolated cache root', () => {
  const root = mkdtempSync(join(tmpdir(), 'metamcp-schema-cache-'));
  const previous = process.env.METAMCP_CACHE_DIR;
  process.env.METAMCP_CACHE_DIR = root;
  try {
    const tools = [tool('read', 'string')];
    writeSchemaCache('fixture', tools);
    const cached = readSchemaCache('fixture');
    assert(cached?.tools[0]?.name === 'read', 'isolated cache did not round-trip');
  } finally {
    if (previous === undefined) delete process.env.METAMCP_CACHE_DIR;
    else process.env.METAMCP_CACHE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
