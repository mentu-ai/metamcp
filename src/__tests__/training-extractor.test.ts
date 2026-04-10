/**
 * Training Extractor Tests
 *
 * Hand-rolled runner (same pattern as recursive.test.ts).
 * Covers: heuristicClassifyDomain, TrainingExtractor routing/relevance/judgment extraction.
 */

import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TrainingExtractor,
  heuristicClassifyDomain,
} from '../training-extractor.js';
import type { RoutingLabel, RelevanceLabel, JudgmentLabel } from '../training-extractor.js';

// ─── Test Runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name} — ${msg}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`${label}: assertion failed`);
  }
}

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const TEST_DIR = join(process.cwd(), '.test-training-extractor');

function cleanTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as T);
}

/** Wait for async file writes to flush. */
function waitForWrites(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 200));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log('Training Extractor Tests\n');

  // --- heuristicClassifyDomain ---

  await test('classifies ghidra server as reverse_engineering', () => {
    assertEqual(heuristicClassifyDomain('decompile_function', 'ghidra'), 'reverse_engineering', 'ghidra server');
  });

  await test('classifies crawlio server as web_crawling', () => {
    assertEqual(heuristicClassifyDomain('start_crawl', 'crawlio'), 'web_crawling', 'crawlio server');
  });

  await test('classifies playwright server as browser_automation', () => {
    assertEqual(heuristicClassifyDomain('browser_click', 'playwright'), 'browser_automation', 'playwright server');
  });

  await test('classifies desktop server as desktop_automation', () => {
    assertEqual(heuristicClassifyDomain('get_ui_tree', 'desktop'), 'desktop_automation', 'desktop server');
  });

  await test('classifies interceptor server as traffic_analysis', () => {
    assertEqual(heuristicClassifyDomain('capture_flow', 'interceptor'), 'traffic_analysis', 'interceptor server');
  });

  await test('classifies cortex server as model_inference', () => {
    assertEqual(heuristicClassifyDomain('classify', 'cortex'), 'model_inference', 'cortex server');
  });

  await test('classifies mentu server as project_management', () => {
    assertEqual(heuristicClassifyDomain('mentu_commit', 'mentu'), 'project_management', 'mentu server');
  });

  await test('classifies neon server as database', () => {
    assertEqual(heuristicClassifyDomain('run_sql', 'neon'), 'database', 'neon server');
  });

  await test('classifies sentry server as monitoring', () => {
    assertEqual(heuristicClassifyDomain('get_issue', 'sentry'), 'monitoring', 'sentry server');
  });

  await test('classifies xcode server as development', () => {
    assertEqual(heuristicClassifyDomain('build_sim', 'xcodebuildmcp'), 'development', 'xcode server');
  });

  await test('classifies context7 as documentation', () => {
    assertEqual(heuristicClassifyDomain('query-docs', 'context7'), 'documentation', 'context7 server');
  });

  await test('classifies unknown tool without server as unknown', () => {
    assertEqual(heuristicClassifyDomain('some_random_tool', ''), 'unknown', 'unknown tool');
  });

  await test('classifies by tool name when server is unknown', () => {
    assertEqual(heuristicClassifyDomain('decompile_function', 'custom_server'), 'reverse_engineering', 'tool name fallback');
  });

  await test('classifies browser tool by name', () => {
    assertEqual(heuristicClassifyDomain('browser_navigate', ''), 'browser_automation', 'browser by name');
  });

  // --- TrainingExtractor: routing labels ---

  await test('extractRoutingLabel writes to mentu-routing.jsonl', async () => {
    cleanTestDir();
    const extractor = new TrainingExtractor(TEST_DIR);
    extractor.extractRoutingLabel('ghidra', 'decompile_function', 'investigate TLS', 250, true);
    await waitForWrites();

    const labels = readJsonl<RoutingLabel>(join(TEST_DIR, 'mentu-routing.jsonl'));
    assertEqual(labels.length, 1, 'one label');
    assertEqual(labels[0]!.output, 'reverse_engineering', 'domain');
    assertEqual(labels[0]!.useful, true, 'useful');
    assertEqual(labels[0]!.source, 'mentu-mcp', 'source');
    assert(labels[0]!.input.includes('ghidra'), 'input has server');
    assert(labels[0]!.duration_ms === 250, 'duration');
    cleanTestDir();
  });

  await test('extractRoutingLabel skips unknown domain', async () => {
    cleanTestDir();
    const extractor = new TrainingExtractor(TEST_DIR);
    extractor.extractRoutingLabel('mystery', 'random_thing', 'test', 100, true);
    await waitForWrites();

    const labels = readJsonl<RoutingLabel>(join(TEST_DIR, 'mentu-routing.jsonl'));
    assertEqual(labels.length, 0, 'no labels for unknown');
    cleanTestDir();
  });

  await test('extractRoutingLabel accumulates multiple labels', async () => {
    cleanTestDir();
    const extractor = new TrainingExtractor(TEST_DIR);
    extractor.extractRoutingLabel('ghidra', 'decompile_function', 'q1', 100, true);
    extractor.extractRoutingLabel('crawlio', 'start_crawl', 'q2', 200, true);
    extractor.extractRoutingLabel('neon', 'run_sql', 'q3', 50, false);
    await waitForWrites();

    const labels = readJsonl<RoutingLabel>(join(TEST_DIR, 'mentu-routing.jsonl'));
    assertEqual(labels.length, 3, 'three labels');
    // Async writes may arrive in any order — check all domains are present
    const domains = new Set(labels.map(l => l.output));
    assert(domains.has('reverse_engineering'), 'has reverse_engineering');
    assert(domains.has('web_crawling'), 'has web_crawling');
    assert(domains.has('database'), 'has database');
    cleanTestDir();
  });

  // --- TrainingExtractor: relevance labels ---

  await test('extractRelevanceLabels writes to mentu-relevance.jsonl', async () => {
    cleanTestDir();
    const extractor = new TrainingExtractor(TEST_DIR);
    extractor.extractRelevanceLabels('find TLS', [
      { tool: 'decompile_function', server: 'ghidra', score: 0.9 },
      { tool: 'run_sql', server: 'neon', score: 0.3 },
    ]);
    await waitForWrites();

    const labels = readJsonl<RelevanceLabel>(join(TEST_DIR, 'mentu-relevance.jsonl'));
    assertEqual(labels.length, 2, 'two labels');
    assertEqual(labels[0]!.output, 'high', 'high score');
    assertEqual(labels[1]!.output, 'low', 'low score');
    assertEqual(labels[0]!.source, 'mentu-discover', 'source');
    cleanTestDir();
  });

  await test('extractRelevanceLabels skips empty results', async () => {
    cleanTestDir();
    const extractor = new TrainingExtractor(TEST_DIR);
    extractor.extractRelevanceLabels('test', []);
    await waitForWrites();

    const labels = readJsonl<RelevanceLabel>(join(TEST_DIR, 'mentu-relevance.jsonl'));
    assertEqual(labels.length, 0, 'no labels for empty');
    cleanTestDir();
  });

  await test('extractRelevanceLabels classifies medium scores', async () => {
    cleanTestDir();
    const extractor = new TrainingExtractor(TEST_DIR);
    extractor.extractRelevanceLabels('test', [
      { tool: 'a', server: 'b', score: 0.5 },
    ]);
    await waitForWrites();

    const labels = readJsonl<RelevanceLabel>(join(TEST_DIR, 'mentu-relevance.jsonl'));
    assertEqual(labels.length, 1, 'one label');
    assertEqual(labels[0]!.output, 'medium', 'medium score');
    cleanTestDir();
  });

  // --- TrainingExtractor: judgment labels ---

  await test('extractJudgmentLabel writes effective outcome', async () => {
    cleanTestDir();
    const extractor = new TrainingExtractor(TEST_DIR);
    extractor.extractJudgmentLabel('full_analysis', ['crawlio', 'ghidra'], 40, 0.7, true);
    await waitForWrites();

    const labels = readJsonl<JudgmentLabel>(join(TEST_DIR, 'mentu-judgment.jsonl'));
    assertEqual(labels.length, 1, 'one label');
    assertEqual(labels[0]!.output, 'effective', 'effective outcome');
    assertEqual(labels[0]!.evidence_quality, 'high', 'high quality');
    assertEqual(labels[0]!.source, 'mentu-judgment', 'source');
    cleanTestDir();
  });

  await test('extractJudgmentLabel writes wasteful when no yield + low budget', async () => {
    cleanTestDir();
    const extractor = new TrainingExtractor(TEST_DIR);
    extractor.extractJudgmentLabel('wasteful test', ['slow_server'], 5, 0.2, false);
    await waitForWrites();

    const labels = readJsonl<JudgmentLabel>(join(TEST_DIR, 'mentu-judgment.jsonl'));
    assertEqual(labels.length, 1, 'one label');
    assertEqual(labels[0]!.output, 'wasteful', 'wasteful outcome');
    assertEqual(labels[0]!.evidence_quality, 'low', 'low quality');
    cleanTestDir();
  });

  await test('extractJudgmentLabel writes insufficient as default', async () => {
    cleanTestDir();
    const extractor = new TrainingExtractor(TEST_DIR);
    extractor.extractJudgmentLabel('test', ['server'], 30, 0.3, false);
    await waitForWrites();

    const labels = readJsonl<JudgmentLabel>(join(TEST_DIR, 'mentu-judgment.jsonl'));
    assertEqual(labels.length, 1, 'one label');
    assertEqual(labels[0]!.output, 'insufficient', 'insufficient outcome');
    cleanTestDir();
  });

  // --- Summary ---

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  ${f}`);
    }
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
