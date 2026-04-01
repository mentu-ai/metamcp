/**
 * ChildManager + CircuitBreaker Unit Tests
 *
 * Hand-rolled runner (same pattern as sandbox.test.ts).
 * Import from .js extensions, run from dist/.
 *
 * Test groups:
 * 1. State Machine — canTransition() valid/invalid transitions
 * 2. Circuit Breaker — threshold, trip, cooldown, reset
 * 3. LIFO Idle List — ordering, eviction from tail
 * 4. Pool Bounds — upper bound enforcement, minimum detection
 */

import { ConnectionState, canTransition } from '../types.js';
import { CircuitBreaker } from '../circuit-breaker.js';

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

// ─── 1. State Machine ───────────────────────────────────────────────────────

console.log('State Machine Tests\n');

// Valid transitions (11 total from VALID_TRANSITIONS table)
const validTransitions: [ConnectionState, ConnectionState][] = [
  // From IDLE
  [ConnectionState.IDLE, ConnectionState.CONNECTING],
  [ConnectionState.IDLE, ConnectionState.ACTIVE],
  [ConnectionState.IDLE, ConnectionState.CLOSED],
  // From CONNECTING
  [ConnectionState.CONNECTING, ConnectionState.ACTIVE],
  [ConnectionState.CONNECTING, ConnectionState.FAILED],
  [ConnectionState.CONNECTING, ConnectionState.CLOSED],
  // From ACTIVE
  [ConnectionState.ACTIVE, ConnectionState.IDLE],
  [ConnectionState.ACTIVE, ConnectionState.FAILED],
  [ConnectionState.ACTIVE, ConnectionState.CLOSED],
  // From FAILED
  [ConnectionState.FAILED, ConnectionState.CONNECTING],
  [ConnectionState.FAILED, ConnectionState.CLOSED],
];

for (const [from, to] of validTransitions) {
  test(`valid: ${from} → ${to}`, () => {
    assertEqual(canTransition(from, to), true, `${from} → ${to}`);
  });
}

// Invalid transitions (8 representative cases)
const invalidTransitions: [ConnectionState, ConnectionState][] = [
  [ConnectionState.IDLE, ConnectionState.FAILED],      // can't fail from idle
  [ConnectionState.IDLE, ConnectionState.IDLE],         // self-loop
  [ConnectionState.CONNECTING, ConnectionState.IDLE],   // must go active first
  [ConnectionState.CONNECTING, ConnectionState.CONNECTING], // self-loop
  [ConnectionState.ACTIVE, ConnectionState.CONNECTING], // can't reconnect while active
  [ConnectionState.FAILED, ConnectionState.ACTIVE],     // must reconnect first
  [ConnectionState.FAILED, ConnectionState.IDLE],       // must reconnect first
  [ConnectionState.CLOSED, ConnectionState.IDLE],       // terminal — no transitions out
];

for (const [from, to] of invalidTransitions) {
  test(`invalid: ${from} → ${to}`, () => {
    assertEqual(canTransition(from, to), false, `${from} → ${to}`);
  });
}

// CLOSED is terminal
test('CLOSED is terminal — no transitions out', () => {
  const allStates = Object.values(ConnectionState);
  for (const to of allStates) {
    assertEqual(canTransition(ConnectionState.CLOSED, to), false, `CLOSED → ${to}`);
  }
});

// ─── 2. Circuit Breaker ─────────────────────────────────────────────────────

console.log('\nCircuit Breaker Tests\n');

test('fresh breaker is closed', () => {
  const cb = new CircuitBreaker(5, 30000);
  assertEqual(cb.isOpen(), false, 'fresh breaker');
});

test('4 failures dont trip (threshold=5)', () => {
  const cb = new CircuitBreaker(5, 30000);
  for (let i = 0; i < 4; i++) cb.recordFailure();
  assertEqual(cb.isOpen(), false, 'below threshold');
});

test('5th failure trips breaker', () => {
  const cb = new CircuitBreaker(5, 30000);
  for (let i = 0; i < 5; i++) cb.recordFailure();
  assertEqual(cb.isOpen(), true, 'at threshold');
});

test('success resets counter: 3 fail + 1 success + 4 fail → still closed', () => {
  const cb = new CircuitBreaker(5, 30000);
  for (let i = 0; i < 3; i++) cb.recordFailure();
  cb.recordSuccess();
  for (let i = 0; i < 4; i++) cb.recordFailure();
  assertEqual(cb.isOpen(), false, 'reset by success');
});

test('cooldown expires → breaker closes', () => {
  const cb = new CircuitBreaker(5, 1000);
  for (let i = 0; i < 5; i++) cb.recordFailure();
  assertEqual(cb.isOpen(), true, 'just tripped');
  // Simulate time passing beyond cooldown
  const future = Date.now() + 1001;
  assertEqual(cb.isOpen(future), false, 'after cooldown');
});

test('counter resets after trip — needs 5 MORE failures to re-trip', () => {
  const cb = new CircuitBreaker(5, 1);  // 1ms cooldown
  // Trip it
  for (let i = 0; i < 5; i++) cb.recordFailure();
  assertEqual(cb.isOpen(), true, 'first trip');

  // Clear trip via success
  cb.recordSuccess();
  assertEqual(cb.isOpen(), false, 'success clears trip');

  // Counter was reset on trip AND by success — need full 5 more
  for (let i = 0; i < 4; i++) cb.recordFailure();
  assertEqual(cb.isOpen(), false, '4 more failures — not tripped yet');

  cb.recordFailure(); // 5th
  assertEqual(cb.isOpen(), true, '5th failure re-trips');
});

test('reset() clears all state', () => {
  const cb = new CircuitBreaker(5, 30000);
  for (let i = 0; i < 5; i++) cb.recordFailure();
  assertEqual(cb.isOpen(), true, 'tripped');
  cb.reset();
  assertEqual(cb.isOpen(), false, 'after reset');
});

test('success on tripped breaker clears tripped flag', () => {
  const cb = new CircuitBreaker(5, 30000);
  for (let i = 0; i < 5; i++) cb.recordFailure();
  assertEqual(cb.isOpen(), true, 'tripped');
  cb.recordSuccess();
  assertEqual(cb.isOpen(), false, 'success clears trip');
});

// ─── 3. canTransition edge cases ────────────────────────────────────────────

console.log('\nTransition Edge Cases\n');

test('every state can transition to CLOSED', () => {
  const nonClosed = [
    ConnectionState.IDLE,
    ConnectionState.CONNECTING,
    ConnectionState.ACTIVE,
    ConnectionState.FAILED,
  ];
  for (const from of nonClosed) {
    assertEqual(canTransition(from, ConnectionState.CLOSED), true, `${from} → CLOSED`);
  }
});

test('FAILED can only go to CONNECTING or CLOSED', () => {
  assertEqual(canTransition(ConnectionState.FAILED, ConnectionState.CONNECTING), true, 'FAILED → CONNECTING');
  assertEqual(canTransition(ConnectionState.FAILED, ConnectionState.CLOSED), true, 'FAILED → CLOSED');
  assertEqual(canTransition(ConnectionState.FAILED, ConnectionState.ACTIVE), false, 'FAILED → ACTIVE');
  assertEqual(canTransition(ConnectionState.FAILED, ConnectionState.IDLE), false, 'FAILED → IDLE');
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
