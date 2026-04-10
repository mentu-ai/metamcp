/**
 * Cortex Budget Advisor Unit Tests
 *
 * Tests tuneWeights() logic: CIR aggregation, bounded adjustments, floor/ceiling.
 * Hand-rolled runner (same pattern as cortex-healer.test.ts).
 */

import { Cortex, WEIGHTS_PATH } from '../cortex.js';
import { DEFAULT_WEIGHTS } from '../judgment.js';
import { EvidenceSessionManager } from '../evidence.js';
import { existsSync, unlinkSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ─── Test Runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
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

// ─── Fake Cortex ─────────────────────────────────────────────────────────────

function makeFakeCortex(): Cortex {
  return Object.create(Cortex.prototype) as Cortex;
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanupWeightsFile(): void {
  try { if (existsSync(WEIGHTS_PATH)) unlinkSync(WEIGHTS_PATH); } catch { /* ok */ }
}

// ─── 1. tuneWeights — returns defaults with insufficient data ────────────────

console.log('Cortex Budget Advisor: tuneWeights Tests\n');

test('tuneWeights returns valid weights (defaults or bounded adjustments)', () => {
  cleanupWeightsFile();
  const cortex = makeFakeCortex();
  const weights = cortex.tuneWeights();
  // All positive weights must be within [0.05, 0.50]
  for (const [k, v] of Object.entries(weights)) {
    if (v > 0) {
      assert(v >= 0.05, `${k} >= 0.05 floor (got ${v})`);
      assert(v <= 0.50, `${k} <= 0.50 ceiling (got ${v})`);
    }
  }
  // Must have all default weight keys
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    assert(k in weights, `weight ${k} exists`);
  }
  // Adjustments are bounded: each differs from default by at most 0.05
  for (const [k, v] of Object.entries(weights)) {
    const def = DEFAULT_WEIGHTS[k];
    if (def !== undefined && def > 0) {
      assert(Math.abs(v - def) <= 0.05 + 0.001, `${k} delta <= 0.05 (got ${Math.abs(v - def)})`);
    }
  }
});

// ─── 2. WEIGHTS_PATH export ──────────────────────────────────────────────────

test('WEIGHTS_PATH ends with mentu-weights.json', () => {
  assert(WEIGHTS_PATH.endsWith('mentu-weights.json'), 'path suffix');
  assert(WEIGHTS_PATH.includes('.mentu'), 'path includes .mentu');
});

// ─── 3. DEFAULT_WEIGHTS structure ────────────────────────────────────────────

test('DEFAULT_WEIGHTS has evidence_potential key', () => {
  assert('evidence_potential' in DEFAULT_WEIGHTS, 'has evidence_potential');
  assertEqual(DEFAULT_WEIGHTS.evidence_potential, 0.20, 'evidence_potential value');
});

test('DEFAULT_WEIGHTS has trust key', () => {
  assert('trust' in DEFAULT_WEIGHTS, 'has trust');
  assertEqual(DEFAULT_WEIGHTS.trust, 0.15, 'trust value');
});

test('DEFAULT_WEIGHTS has novelty key', () => {
  assert('novelty' in DEFAULT_WEIGHTS, 'has novelty');
  assertEqual(DEFAULT_WEIGHTS.novelty, 0.10, 'novelty value');
});

// ─── 4. EvidenceSessionManager onClose hook ──────────────────────────────────

console.log('\nCortex Budget Advisor: EvidenceSessionManager Hook Tests\n');

test('onClose callback fires with incrementing count', () => {
  const mgr = new EvidenceSessionManager();
  const counts: number[] = [];
  mgr.onClose((count) => counts.push(count));

  mgr.start('goal-1');
  mgr.close();
  mgr.start('goal-2');
  mgr.close();
  mgr.start('goal-3');
  mgr.close();

  assertEqual(counts.length, 3, 'callback count');
  assertEqual(counts[0], 1, 'first close count');
  assertEqual(counts[1], 2, 'second close count');
  assertEqual(counts[2], 3, 'third close count');
});

test('closeCount tracks total closes', () => {
  const mgr = new EvidenceSessionManager();
  assertEqual(mgr.closeCount, 0, 'initial count');
  mgr.start('g1');
  mgr.close();
  assertEqual(mgr.closeCount, 1, 'after first close');
  mgr.start('g2');
  mgr.close();
  assertEqual(mgr.closeCount, 2, 'after second close');
});

test('onClose not called when close returns null (no active session)', () => {
  const mgr = new EvidenceSessionManager();
  let called = false;
  mgr.onClose(() => { called = true; });
  mgr.close(); // no active session
  assert(!called, 'should not fire');
  assertEqual(mgr.closeCount, 0, 'count stays 0');
});

test('onClose error does not propagate', () => {
  const mgr = new EvidenceSessionManager();
  mgr.onClose(() => { throw new Error('boom'); });
  mgr.start('goal');
  // Should not throw
  const summary = mgr.close();
  assert(summary !== null, 'summary returned');
});

test('auto-created session via recordCall also triggers onClose', () => {
  const mgr = new EvidenceSessionManager();
  const counts: number[] = [];
  mgr.onClose((count) => counts.push(count));

  // recordCall auto-creates session
  mgr.recordCall('server', 'tool', {}, 'output', 100, true, 'mcp_call');
  // Start a new session forces close of auto-created one
  mgr.start('explicit');
  assertEqual(counts.length, 1, 'auto-session close fired');
  assertEqual(counts[0], 1, 'count is 1');
});

// ─── 5. Weight bounds ────────────────────────────────────────────────────────

console.log('\nCortex Budget Advisor: Weight Bound Constraints\n');

test('all DEFAULT_WEIGHTS are within [0.05, 0.50] or negative', () => {
  for (const [k, v] of Object.entries(DEFAULT_WEIGHTS)) {
    if (v > 0) {
      assert(v >= 0.05, `${k} >= 0.05 floor (got ${v})`);
      assert(v <= 0.50, `${k} <= 0.50 ceiling (got ${v})`);
    }
    // Negative weights (cost, circuit_health) are allowed to be negative
  }
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
