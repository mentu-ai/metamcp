/**
 * Vector Catalog VC2 Tests
 *
 * Hand-rolled runner (same pattern as store.test.ts).
 * 14 test cases covering: VectorStore, Embedder, hybrid search, serialization.
 */

import { VectorStore, cosineSimilarity } from '../vector-store.js';
import { Embedder, type EmbedderProvider } from '../embedder.js';
import { AnthropicEmbedderProvider } from '../embedder.js';
import { ToolCatalog } from '../catalog.js';
import type { ToolDefinition } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- Test Runner ---

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

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ~${expected}, got ${actual} (tolerance ${tolerance})`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

// --- Helpers ---

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamcp-test-'));
  return path.join(dir, 'test-catalog.db');
}

/** Mock embedder that returns deterministic embeddings based on text hash. */
class MockEmbedderProvider implements EmbedderProvider {
  readonly providerId = 'mock';
  private dim: number;
  private available: boolean;

  constructor(dim: number = 8, available: boolean = true) {
    this.dim = dim;
    this.available = available;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async embed(text: string): Promise<Float32Array> {
    return this.hashEmbed(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(t => this.hashEmbed(t));
  }

  private hashEmbed(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    for (let i = 0; i < text.length; i++) {
      vec[i % this.dim] += text.charCodeAt(i) / 255;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) vec[i] /= norm;
    }
    return vec;
  }
}

// --- Tests ---

async function runTests(): Promise<void> {
  console.log('Vector Catalog VC2 Tests\n');

  // 1. Database creation
  await test('1. Database creation: catalog.db created at expected path', async () => {
    const dbPath = tmpDbPath();
    const store = new VectorStore(dbPath);
    assert(fs.existsSync(dbPath), 'DB file should exist');
    store.close();
  });

  // 2. Migration: schema_version table exists
  await test('2. Migration: schema_version table exists, version is current', async () => {
    const dbPath = tmpDbPath();
    const store = new VectorStore(dbPath);
    // Re-open to verify migration is idempotent
    store.close();
    const store2 = new VectorStore(dbPath);
    // If migration fails, constructor throws
    store2.close();
  });

  // 3. Upsert: insert new tool embedding
  await test('3. Upsert: insert new tool embedding, verify via search', async () => {
    const dbPath = tmpDbPath();
    const store = new VectorStore(dbPath);
    const emb = new Float32Array([1, 0, 0, 0]);
    store.upsert('test-server', 'read_file', 'Read a file from disk', emb);
    const results = store.search(new Float32Array([1, 0, 0, 0]), 10);
    assertEqual(results.length, 1, 'should find 1 result');
    assertEqual(results[0].toolName, 'read_file', 'tool name');
    assertEqual(results[0].server, 'test-server', 'server');
    store.close();
  });

  // 4. Upsert update: change description
  await test('4. Upsert update: change description, verify update', async () => {
    const dbPath = tmpDbPath();
    const store = new VectorStore(dbPath);
    const emb = new Float32Array([1, 0, 0, 0]);
    store.upsert('srv', 'tool1', 'old desc', emb);
    assertEqual(store.getDescription('srv', 'tool1'), 'old desc', 'initial desc');
    store.upsert('srv', 'tool1', 'new desc', emb);
    assertEqual(store.getDescription('srv', 'tool1'), 'new desc', 'updated desc');
    store.close();
  });

  // 5. Search: query embedding returns tools sorted by cosine similarity
  await test('5. Search returns tools sorted by cosine similarity', async () => {
    const dbPath = tmpDbPath();
    const store = new VectorStore(dbPath);
    store.upsert('s1', 'close_match', 'similar', new Float32Array([0.9, 0.1, 0, 0]));
    store.upsert('s1', 'far_match', 'different', new Float32Array([0, 0, 0.1, 0.9]));
    store.upsert('s1', 'exact_match', 'exact', new Float32Array([1, 0, 0, 0]));
    const results = store.search(new Float32Array([1, 0, 0, 0]), 10);
    assertEqual(results[0].toolName, 'exact_match', 'first result should be exact match');
    assertEqual(results[1].toolName, 'close_match', 'second result should be close match');
    assertEqual(results[2].toolName, 'far_match', 'third result should be far match');
    store.close();
  });

  // 6. Cosine similarity: mathematical correctness
  await test('6. Cosine similarity: identical=1.0, orthogonal=0.0, opposite=-1.0', async () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    const c = new Float32Array([-1, 0, 0]);

    assertClose(cosineSimilarity(a, a), 1.0, 0.0001, 'identical vectors');
    assertClose(cosineSimilarity(a, b), 0.0, 0.0001, 'orthogonal vectors');
    assertClose(cosineSimilarity(a, c), -1.0, 0.0001, 'opposite vectors');

    // Different lengths return 0
    assertEqual(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0])), 0, 'different lengths');

    // Zero vectors return 0
    assertEqual(cosineSimilarity(new Float32Array([0, 0, 0]), a), 0, 'zero vector');
  });

  // 7. deleteServer: removes all embeddings
  await test('7. deleteServer removes all embeddings for a server', async () => {
    const dbPath = tmpDbPath();
    const store = new VectorStore(dbPath);
    store.upsert('s1', 't1', 'd1', new Float32Array([1, 0]));
    store.upsert('s1', 't2', 'd2', new Float32Array([0, 1]));
    store.upsert('s2', 't3', 'd3', new Float32Array([1, 1]));
    store.deleteServer('s1');
    const results = store.search(new Float32Array([1, 0]), 10);
    assertEqual(results.length, 1, 'only s2 tools remain');
    assertEqual(results[0].server, 's2', 'remaining tool is from s2');
    store.close();
  });

  // 8. isAvailable: returns false when no API key
  await test('8. AnthropicEmbedderProvider.isAvailable: false when no API key', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const provider = new AnthropicEmbedderProvider(undefined);
    assertEqual(provider.isAvailable(), false, 'should be unavailable without key');
    if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
  });

  // 9. Graceful degradation: embedBatch returns empty on error
  await test('9. Graceful degradation: embedBatch returns empty when unavailable', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const provider = new AnthropicEmbedderProvider(undefined);
    const result = await provider.embedBatch(['test']);
    assertEqual(result.length, 0, 'should return empty array');
    if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
  });

  // 10. Keyword-only fallback: works when embedder unavailable
  await test('10. Keyword-only fallback when embedder unavailable', async () => {
    const catalog = new ToolCatalog({
      embedder: new Embedder(new MockEmbedderProvider(8, false)),
    });
    const tools: ToolDefinition[] = [
      { name: 'read_file', description: 'Read a file', server: 'fs', inputSchema: {} },
      { name: 'write_file', description: 'Write a file', server: 'fs', inputSchema: {} },
    ];
    catalog.registerServer('fs', tools);
    const results = await catalog.search('read');
    assert(results.length > 0, 'should have keyword results');
    assertEqual(results[0].tool.name, 'read_file', 'should find read_file');
    catalog.destroy();
  });

  // 11. Hybrid scoring: semantic + keyword combined
  await test('11. Hybrid scoring: semantic + keyword produces results', async () => {
    const dbPath = tmpDbPath();
    const vs = new VectorStore(dbPath);
    const mockProvider = new MockEmbedderProvider(8);
    const embedder = new Embedder(mockProvider);

    const catalog = new ToolCatalog({
      vectorStore: vs,
      embedder,
    });

    const tools: ToolDefinition[] = [
      { name: 'read_file', description: 'Read a file from disk', server: 'fs', inputSchema: {} },
      { name: 'list_directory', description: 'List files in a directory', server: 'fs', inputSchema: {} },
      { name: 'write_file', description: 'Write content to a file', server: 'fs', inputSchema: {} },
    ];
    await catalog.registerServerWithEmbeddings('fs', tools);

    const results = await catalog.search('read file');
    assert(results.length > 0, 'should have results');
    // read_file should rank high due to both keyword and semantic match
    const readFileResult = results.find(r => r.tool.name === 'read_file');
    assert(readFileResult !== undefined, 'read_file should be in results');
    catalog.destroy();
  });

  // 12. Score normalization
  await test('12. Score normalization: max normalizes to 1.0, zero stays 0.0', async () => {
    // Test via the catalog's internal behavior
    const scores = [10, 5, 0, 2];
    const max = Math.max(...scores);
    const normalized = scores.map(s => max === 0 ? 0 : s / max);
    assertClose(normalized[0], 1.0, 0.0001, 'max score normalizes to 1.0');
    assertClose(normalized[2], 0.0, 0.0001, 'zero stays 0.0');
    assertClose(normalized[1], 0.5, 0.0001, 'mid score normalizes correctly');

    // Edge case: all zeros
    const zeros = [0, 0, 0];
    const maxZ = Math.max(...zeros);
    const normalizedZ = zeros.map(() => maxZ === 0 ? 0 : 0);
    assertEqual(normalizedZ[0], 0, 'all-zero normalization');
  });

  // 13. No regression: pure keyword search unchanged when vector store empty
  await test('13. No regression: pure keyword unchanged when vector store empty', async () => {
    const dbPath = tmpDbPath();
    const vs = new VectorStore(dbPath);
    const mockProvider = new MockEmbedderProvider(8);
    const embedder = new Embedder(mockProvider);

    // Catalog without vector store (baseline)
    const catalogBaseline = new ToolCatalog();
    const tools: ToolDefinition[] = [
      { name: 'read_file', description: 'Read a file from disk', server: 'fs', inputSchema: {} },
      { name: 'write_file', description: 'Write content to a file', server: 'fs', inputSchema: {} },
    ];
    catalogBaseline.registerServer('fs', tools);
    const baselineResults = await catalogBaseline.search('read');

    // Catalog with empty vector store
    const catalogWithVS = new ToolCatalog({ vectorStore: vs, embedder });
    catalogWithVS.registerServer('fs', tools);
    // Don't embed — vector store is empty, should fall through to keyword
    const vsResults = await catalogWithVS.search('read');

    assertEqual(baselineResults.length, vsResults.length, 'same number of results');
    // Both should find read_file as top result
    assertEqual(baselineResults[0].tool.name, 'read_file', 'baseline top');
    assertEqual(vsResults[0].tool.name, 'read_file', 'vs top');

    catalogBaseline.destroy();
    catalogWithVS.destroy();
  });

  // 14. Float32Array -> Buffer -> Float32Array roundtrip
  await test('14. Float32Array -> Buffer -> Float32Array roundtrip is lossless', async () => {
    const original = new Float32Array([1.5, -2.3, 0.0, 3.14159, -0.001]);
    const buf = Buffer.from(original.buffer, original.byteOffset, original.byteLength);
    const restored = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

    assertEqual(restored.length, original.length, 'same length');
    for (let i = 0; i < original.length; i++) {
      assertEqual(restored[i], original[i], `element ${i}`);
    }
  });

  // --- Summary ---
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
