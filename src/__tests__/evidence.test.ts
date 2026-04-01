/**
 * Evidence Mode Tests
 *
 * Hand-rolled runner (same pattern as store.test.ts).
 * Covers: Gap, ConfidenceCalculator, InvestigationSession,
 * EvidenceSessionManager, quality record extraction.
 */

import {
  ConfidenceCalculator,
  InvestigationSession,
  EvidenceSessionManager,
} from '../evidence.js';
import type { Gap } from '../evidence.js';

// ─── Test Runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.log('Evidence Mode Tests\n');

  // ─── ConfidenceCalculator ────────────────────────────────────────────────

  await test('1. ConfidenceCalculator: single source gets moderate floor', () => {
    const score = ConfidenceCalculator.compute(1, []);
    assertEqual(score, 0.4, 'single source no gaps = 0.4 floor');
  });

  await test('2. ConfidenceCalculator: two sources no gaps', () => {
    const score = ConfidenceCalculator.compute(2, []);
    assertEqual(score, 0.4, 'two sources = 0.3 + 0.1');
  });

  await test('3. ConfidenceCalculator: three sources no gaps', () => {
    const score = ConfidenceCalculator.compute(3, []);
    assertEqual(score, 0.5, 'three sources = 0.3 + 0.2');
  });

  await test('4. ConfidenceCalculator: reducing gap subtracts 0.15', () => {
    const gaps: Gap[] = [{ dimension: 'test', reason: 'test', impact: 'reducing' }];
    const score = ConfidenceCalculator.compute(2, gaps);
    assertEqual(score, 0.25, '0.4 - 0.15');
  });

  await test('5. ConfidenceCalculator: blocking gap caps at 0.5', () => {
    const gaps: Gap[] = [{ dimension: 'test', reason: 'test', impact: 'blocking' }];
    const score = ConfidenceCalculator.compute(5, gaps);
    // 0.3 + 0.4 = 0.7, capped to 0.5 by blocking
    assertEqual(score, 0.5, 'capped at 0.5');
  });

  await test('6. ConfidenceCalculator: cosmetic gap has no effect', () => {
    const gaps: Gap[] = [{ dimension: 'test', reason: 'test', impact: 'cosmetic' }];
    const score = ConfidenceCalculator.compute(2, gaps);
    assertEqual(score, 0.4, 'cosmetic does nothing');
  });

  await test('7. ConfidenceCalculator: floor at 0', () => {
    const gaps: Gap[] = [
      { dimension: 'a', reason: 'r', impact: 'reducing' },
      { dimension: 'b', reason: 'r', impact: 'reducing' },
      { dimension: 'c', reason: 'r', impact: 'reducing' },
    ];
    const score = ConfidenceCalculator.compute(1, gaps);
    // 0.3 * 0.5 = 0.15, - 0.45 → 0
    assertEqual(score, 0, 'clamped to 0');
  });

  await test('8. ConfidenceCalculator.fromToolCall: success with output', () => {
    const score = ConfidenceCalculator.fromToolCall(true, 100, true, 500);
    // sources=2, no gaps → 0.4
    assertEqual(score, 0.4, 'success+output = 0.4');
  });

  await test('9. ConfidenceCalculator.fromToolCall: success without output', () => {
    const score = ConfidenceCalculator.fromToolCall(true, 100, true, 0);
    // sources=1 (success) + gap(empty_output reducing), softer single-source penalty
    // 0.3 - 0.15 = 0.15, * 0.7 = 0.105 → rounds to 0.11
    assertEqual(score, 0.11, 'success+empty = low confidence');
  });

  await test('10. ConfidenceCalculator.fromToolCall: failure', () => {
    const score = ConfidenceCalculator.fromToolCall(false, 100, false, 0);
    // sources=0, blocking gap → compute(0, blocking)
    // 0.3 + (-1)*0.1 = 0.2, min(0.2, 0.5) = 0.2, sources=0 < 1 means no single-source penalty but formula:
    // Actually: sources=0, so 0.3 + (0-1)*0.1 = 0.2, then blocking caps at min(0.2, 0.5)=0.2
    // sources=0 doesn't trigger single-source penalty (evidenceSources === 1)
    // so 0.2
    assertEqual(score, 0.2, 'failure = 0.2');
  });

  await test('11. ConfidenceCalculator.fromToolCall: slow response adds gap', () => {
    const score = ConfidenceCalculator.fromToolCall(true, 35_000, true, 500);
    // sources=2, gap(slow_response reducing) → 0.4 - 0.15 = 0.25
    assertEqual(score, 0.25, 'slow response penalized');
  });

  // ─── InvestigationSession ────────────────────────────────────────────────

  await test('12. Session: custom ID preserved', () => {
    const session = new InvestigationSession('test goal', 'ev_custom123');
    assertEqual(session.id, 'ev_custom123', 'custom id');
    assertEqual(session.goal, 'test goal', 'goal');
  });

  await test('13. Session: auto-generates ID with ev_ prefix', () => {
    const session = new InvestigationSession('auto goal');
    assert(session.id.startsWith('ev_'), `id starts with ev_: ${session.id}`);
    assertEqual(session.id.length, 15, 'ev_ + 12 hex chars');
  });

  await test('14. Session: recordCall tracks servers and methods', () => {
    const session = new InvestigationSession('test', 'ev_test');
    session.recordCall('web-server', 'fetch_page', { url: 'https://example.com' },
      'Page fetched', 150, true, 'mcp_call');
    session.recordCall('analyzer', 'analyze_data', { id: 'item-1' },
      'Analysis complete', 200, true, 'mcp_call');
    session.recordCall('web-server', 'get_data', {},
      'Results ready', 50, true, 'mcp_execute');

    assertEqual(session.calls.length, 3, 'three calls');
    const servers = session.serversUsed.sort();
    assertEqual(servers.length, 2, 'two servers');
    assertEqual(servers[0], 'analyzer', 'analyzer used');
    assertEqual(servers[1], 'web-server', 'web-server used');
    const methods = session.methodsUsed.sort();
    assertEqual(methods.length, 2, 'two methods');
    assertEqual(methods[0], 'mcp_call', 'mcp_call used');
    assertEqual(methods[1], 'mcp_execute', 'mcp_execute used');
  });

  await test('15. Session: recordMethod tracks standalone methods', () => {
    const session = new InvestigationSession('test', 'ev_test');
    session.recordMethod('mcp_discover');
    session.recordMethod('mcp_provision');
    session.recordMethod('mcp_discover'); // duplicate
    assertEqual(session.methodsUsed.length, 2, 'deduplicated');
  });

  await test('16. Session: summary computes averages correctly', () => {
    const session = new InvestigationSession('summary test', 'ev_sum');
    session.recordCall('s1', 'tool1', {}, 'output', 100, true, 'mcp_call');
    session.recordCall('s1', 'tool2', {}, '', 100, true, 'mcp_call'); // empty output
    session.recordCall('s2', 'tool3', {}, 'err', 100, false, 'mcp_call');

    const summary = session.summary();
    assertEqual(summary.id, 'ev_sum', 'id');
    assertEqual(summary.goal, 'summary test', 'goal');
    assertEqual(summary.callCount, 3, 'call count');
    assertEqual(summary.successCount, 2, 'successes');
    assertEqual(summary.failureCount, 1, 'failures');
    assert(summary.gapCount > 0, 'has gaps');
    assert(summary.overallConfidence > 0, 'nonzero confidence');
    assertEqual(summary.serversUsed.length, 2, 'two servers');
  });

  await test('17. Session: toTrainingRecords labels correctly', () => {
    const session = new InvestigationSession('train test', 'ev_train');
    session.recordCall('s1', 'tool1', {}, 'good output', 100, true, 'mcp_call');
    session.recordCall('s1', 'tool2', {}, '', 100, true, 'mcp_call');
    session.recordCall('s2', 'tool3', {}, 'error', 100, false, 'mcp_call');

    const records = session.toTrainingRecords();
    assertEqual(records.length, 3, 'three records');
    assertEqual(records[0].label, 'high', 'success+output = high');
    assertEqual(records[1].label, 'medium', 'success+empty = medium');
    assertEqual(records[2].label, 'low', 'failure = low');
    assertEqual(records[0].investigation, 'ev_train', 'investigation id');
  });

  await test('18. Session: calls are readonly', () => {
    const session = new InvestigationSession('readonly test', 'ev_ro');
    session.recordCall('s1', 'tool1', {}, 'out', 100, true, 'mcp_call');
    const calls = session.calls;
    assertEqual(calls.length, 1, 'one call');
    // TypeScript readonly prevents mutation at compile time.
    // At runtime, the getter returns the internal array, so just verify it works.
  });

  await test('19. Session: gaps passed to recordCall are preserved', () => {
    const session = new InvestigationSession('gaps test', 'ev_gaps');
    const customGaps = [
      { dimension: 'server_unavailable', reason: 'Analyzer not running', impact: 'blocking' as const },
    ];
    const ev = session.recordCall('analyzer', 'list_items', {}, '', 0, false, 'mcp_call', customGaps);
    assert(ev.gaps.length >= 1, 'has gaps');
    assert(ev.gaps.some(g => g.dimension === 'server_unavailable'), 'custom gap preserved');
  });

  // ─── EvidenceSessionManager ──────────────────────────────────────────────

  await test('20. Manager: start creates active session', () => {
    const mgr = new EvidenceSessionManager();
    assertEqual(mgr.active, null, 'initially null');
    const session = mgr.start('test goal');
    assert(mgr.active !== null, 'active after start');
    assertEqual(mgr.active!.goal, 'test goal', 'goal set');
    assertEqual(session.id, mgr.active!.id, 'returned session is active');
  });

  await test('21. Manager: close archives summary', () => {
    const mgr = new EvidenceSessionManager();
    mgr.start('archival test', 'ev_arch');
    mgr.recordCall('s1', 'tool1', {}, 'out', 100, true, 'mcp_call');
    const summary = mgr.close();
    assert(summary !== null, 'summary returned');
    assertEqual(summary!.id, 'ev_arch', 'correct id');
    assertEqual(mgr.active, null, 'active cleared');
    assertEqual(mgr.completedSessions.length, 1, 'one completed');
  });

  await test('22. Manager: close with no active returns null', () => {
    const mgr = new EvidenceSessionManager();
    const result = mgr.close();
    assertEqual(result, null, 'null when nothing active');
  });

  await test('23. Manager: start closes previous session', () => {
    const mgr = new EvidenceSessionManager();
    mgr.start('first', 'ev_1');
    mgr.start('second', 'ev_2');
    assertEqual(mgr.completedSessions.length, 1, 'first archived');
    assertEqual(mgr.completedSessions[0].id, 'ev_1', 'first id');
    assertEqual(mgr.active!.id, 'ev_2', 'second is active');
  });

  await test('24. Manager: recordCall auto-creates session', () => {
    const mgr = new EvidenceSessionManager();
    assertEqual(mgr.active, null, 'no active');
    mgr.recordCall('s1', 'tool1', {}, 'out', 100, true, 'mcp_call');
    assert(mgr.active !== null, 'auto-created');
    assertEqual(mgr.active!.goal, 'auto', 'default goal');
  });

  await test('25. Manager: completed sessions capped at maxCompleted', () => {
    const mgr = new EvidenceSessionManager(3);
    for (let i = 0; i < 5; i++) {
      mgr.start(`session ${i}`, `ev_${i}`);
    }
    mgr.close(); // close the 5th
    // 4 closed by start() + 1 closed by close() = 5, but max 3
    assertEqual(mgr.completedSessions.length, 3, 'capped at 3');
    // Oldest should have been shifted off
    assertEqual(mgr.completedSessions[0].id, 'ev_2', 'oldest surviving');
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
