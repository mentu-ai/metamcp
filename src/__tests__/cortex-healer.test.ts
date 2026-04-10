/**
 * Cortex Auto-Healer Unit Tests
 *
 * Tests diagnoseFailure() cause classification and attemptHeal() logic.
 * Hand-rolled runner (same pattern as child-manager.test.ts).
 */

import type { ServerConfig } from '../types.js';
import { Cortex, type Diagnosis } from '../cortex.js';

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

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
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

// ─── Fake Cortex (no real ChildManager needed for diagnoseFailure) ───────────

// We create a minimal Cortex by bypassing the constructor's hook registration.
// diagnoseFailure and attemptHeal are instance methods, so we need a real instance.
// Use Object.create to skip constructor, then call methods directly.

function makeFakeCortex(): Cortex {
  const fake = Object.create(Cortex.prototype) as Cortex;
  return fake;
}

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'test-server',
    command: 'echo',
    criticality: 'optional',
    ...overrides,
  };
}

// ─── 1. diagnoseFailure — Cause Classification ──────────────────────────────

console.log('Cortex Auto-Healer: Diagnosis Tests\n');

test('binary_missing: nonexistent command path', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig({ command: '/nonexistent/path/to/binary' });
  const d = cortex.diagnoseFailure(config, new Error('spawn ENOENT'));
  assertEqual(d.cause, 'binary_missing', 'cause');
  assertEqual(d.autoFixable, false, 'not auto-fixable');
  assert(d.detail.includes('/nonexistent/path/to/binary'), 'detail mentions path');
});

test('binary_missing: command not on PATH', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig({ command: 'definitely-not-a-real-binary-xyz123' });
  const d = cortex.diagnoseFailure(config, new Error('spawn ENOENT'));
  assertEqual(d.cause, 'binary_missing', 'cause');
  assertEqual(d.autoFixable, false, 'not auto-fixable');
});

test('binary_missing skipped for http transport', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig({ command: '/nonexistent/path', transport: 'http' });
  const d = cortex.diagnoseFailure(config, new Error('connection refused'));
  // Should NOT be binary_missing since it's HTTP
  assert(d.cause !== 'binary_missing', 'not binary_missing for http');
});

test('binary_missing skipped for sse transport', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig({ command: '/nonexistent/path', transport: 'sse' });
  const d = cortex.diagnoseFailure(config, new Error('connection refused'));
  assert(d.cause !== 'binary_missing', 'not binary_missing for sse');
});

test('credential_expired: 401 error', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig();
  const d = cortex.diagnoseFailure(config, new Error('HTTP 401 Unauthorized'));
  assertEqual(d.cause, 'credential_expired', 'cause');
  assertEqual(d.autoFixable, true, 'auto-fixable');
  assertEqual(d.fixAction, 'vault_refresh', 'fix action');
});

test('credential_expired: unauthorized keyword', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig();
  const d = cortex.diagnoseFailure(config, new Error('Request unauthorized'));
  assertEqual(d.cause, 'credential_expired', 'cause');
});

test('credential_expired: token expired', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig();
  const d = cortex.diagnoseFailure(config, new Error('Token expired at 2026-01-01'));
  assertEqual(d.cause, 'credential_expired', 'cause');
  assertEqual(d.fixAction, 'vault_refresh', 'fix action');
});

test('port_conflict: EADDRINUSE', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig();
  const d = cortex.diagnoseFailure(config, new Error('listen EADDRINUSE: address already in use :::3000'));
  assertEqual(d.cause, 'port_conflict', 'cause');
  assertEqual(d.autoFixable, false, 'not auto-fixable');
});

test('daemon_down: mentu-ane server', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig({ name: 'mentu-ane' });
  const d = cortex.diagnoseFailure(config, new Error('connection refused'));
  assertEqual(d.cause, 'daemon_down', 'cause');
  assertEqual(d.autoFixable, true, 'auto-fixable');
  assertEqual(d.fixAction, 'restart_ane', 'fix action');
});

test('daemon_down: ane-control.sock error', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig();
  const d = cortex.diagnoseFailure(config, new Error('connect ENOENT /Users/x/.mentu/ane-control.sock'));
  assertEqual(d.cause, 'daemon_down', 'cause');
  assertEqual(d.fixAction, 'restart_ane', 'fix action');
});

test('binary_crash: exit code error', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig();
  const d = cortex.diagnoseFailure(config, new Error('Process exit code 1'));
  assertEqual(d.cause, 'binary_crash', 'cause');
  assertEqual(d.autoFixable, false, 'not auto-fixable');
});

test('binary_crash: connection closed', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig();
  const d = cortex.diagnoseFailure(config, new Error('Connection closed unexpectedly'));
  assertEqual(d.cause, 'binary_crash', 'cause');
});

test('unknown: unrecognized error', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig();
  const d = cortex.diagnoseFailure(config, new Error('Something completely unexpected'));
  assertEqual(d.cause, 'unknown', 'cause');
  assertEqual(d.autoFixable, false, 'not auto-fixable');
  assert(d.fixAction === undefined, 'no fix action');
});

test('server name is set correctly in diagnosis', () => {
  const cortex = makeFakeCortex();
  const config = makeConfig({ name: 'my-special-server' });
  const d = cortex.diagnoseFailure(config, new Error('unknown'));
  assertEqual(d.server, 'my-special-server', 'server name');
});

// ─── 2. attemptHeal ─────────────────────────────────────────────────────────

console.log('\nCortex Auto-Healer: Heal Tests\n');

await testAsync('vault_refresh heal clears cache and returns true', async () => {
  const cortex = makeFakeCortex();
  const diagnosis: Diagnosis = {
    server: 'test',
    cause: 'credential_expired',
    detail: '401',
    autoFixable: true,
    fixAction: 'vault_refresh',
  };
  const result = await cortex.attemptHeal(diagnosis);
  assertEqual(result, true, 'vault refresh succeeds');
});

await testAsync('unknown fixAction returns false', async () => {
  const cortex = makeFakeCortex();
  const diagnosis: Diagnosis = {
    server: 'test',
    cause: 'unknown',
    detail: 'whatever',
    autoFixable: false,
  };
  const result = await cortex.attemptHeal(diagnosis);
  assertEqual(result, false, 'no fix action');
});

await testAsync('restart_ane returns boolean (does not throw)', async () => {
  const cortex = makeFakeCortex();
  const diagnosis: Diagnosis = {
    server: 'mentu-ane',
    cause: 'daemon_down',
    detail: 'connection refused',
    autoFixable: true,
    fixAction: 'restart_ane',
  };
  // May return true (if ANECLI exists) or false (if not) — either is correct
  const result = await cortex.attemptHeal(diagnosis);
  assertEqual(typeof result, 'boolean', 'restart_ane returns a boolean');
});

// ─── 3. Priority ordering: binary_missing beats credential_expired ──────────

console.log('\nCortex Auto-Healer: Priority Tests\n');

test('binary check runs before credential check', () => {
  const cortex = makeFakeCortex();
  // Error message matches credential pattern, but binary is also missing
  const config = makeConfig({ command: '/nonexistent/binary/xyz' });
  const d = cortex.diagnoseFailure(config, new Error('HTTP 401 Unauthorized'));
  // binary_missing should win because it's checked first
  assertEqual(d.cause, 'binary_missing', 'binary_missing takes priority');
});

test('existing binary falls through to credential check', () => {
  const cortex = makeFakeCortex();
  // 'echo' exists on PATH, so binary check passes → falls through to credential
  const config = makeConfig({ command: 'echo' });
  const d = cortex.diagnoseFailure(config, new Error('HTTP 401 Unauthorized'));
  assertEqual(d.cause, 'credential_expired', 'credential check after binary passes');
});

// ─── 4. SpawnFailureHook integration ────────────────────────────────────────

console.log('\nCortex Auto-Healer: Hook Integration Tests\n');

test('onSpawnFailure hook is exposed on ChildManager', async () => {
  // We can't easily create a ChildManager without deps, but we can import and check the type
  const { ChildManager } = await import('../child-manager.js');
  assert(typeof ChildManager.prototype.onSpawnFailure === 'function', 'onSpawnFailure method exists');
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
