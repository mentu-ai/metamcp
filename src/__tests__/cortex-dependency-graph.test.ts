/**
 * Cortex Dependency Graph + VM Routing Tests
 *
 * Tests resolveDependencies() and shouldRouteViaVM() logic.
 * Hand-rolled runner (same pattern as cortex-healer.test.ts).
 */

import type { ServerConfig, ChildState } from '../types.js';
import { ConnectionState } from '../types.js';
import { Cortex } from '../cortex.js';
import type { ServerDependency } from '../config.js';

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

// ─── Fake ChildManager for testing ───────────────────────────────────────────

class FakeChildManager {
  private states: ChildState[] = [];
  private started: string[] = [];

  setStates(states: ChildState[]) {
    this.states = states;
  }

  getAllStates(): ChildState[] {
    return this.states;
  }

  getStarted(): string[] {
    return this.started;
  }

  private failSpawn = new Set<string>();

  setSpawnFail(name: string) {
    this.failSpawn.add(name);
  }

  async spawn(config: ServerConfig): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    if (this.failSpawn.has(config.name)) throw new Error(`spawn failed: ${config.name}`);
    this.started.push(config.name);
    const existing = this.states.find(s => s.name === config.name);
    if (existing) existing.state = ConnectionState.IDLE;
    return [];
  }

  // Minimal stubs for Cortex constructor
  onSpawnFailure(_hook: unknown) { /* noop */ }
}

function makeFakeCortex(
  configs: ServerConfig[] = [],
  dependencies: Record<string, ServerDependency> = {},
  childStates: ChildState[] = [],
): { cortex: Cortex; cm: FakeChildManager } {
  const cm = new FakeChildManager();
  cm.setStates(childStates);

  // Bypass constructor to avoid ChildManager type issues
  const cortex = Object.create(Cortex.prototype) as Cortex;
  // Manually set private fields via indexed access
  (cortex as any).perception = { stats: () => ({}) };
  (cortex as any).childManager = cm;
  (cortex as any).serverConfigs = configs;
  (cortex as any).dependencies = dependencies;

  return { cortex, cm };
}

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'test-server',
    command: 'echo',
    criticality: 'optional',
    ...overrides,
  };
}

function makeState(overrides: Partial<ChildState> = {}): ChildState {
  return {
    name: 'test-server',
    state: ConnectionState.IDLE,
    toolCount: 5,
    criticality: 'optional',
    restartCount: 0,
    ...overrides,
  };
}

// ─── 1. resolveDependencies ──────────────────────────────────────────────────

console.log('Cortex Dependency Graph: resolveDependencies Tests\n');

await testAsync('no dependencies → resolved: true, empty issues', async () => {
  const { cortex } = makeFakeCortex();
  const result = await cortex.resolveDependencies('some-server');
  assertEqual(result.resolved, true, 'resolved');
  assertEqual(result.issues.length, 0, 'no issues');
});

await testAsync('requires_env: present → resolved', async () => {
  process.env['TEST_DEP_VAR_EXISTS'] = '1';
  const { cortex } = makeFakeCortex([], {
    'my-server': { requires_env: ['TEST_DEP_VAR_EXISTS'] },
  });
  const result = await cortex.resolveDependencies('my-server');
  assertEqual(result.resolved, true, 'resolved');
  assertEqual(result.issues.length, 0, 'no issues');
  delete process.env['TEST_DEP_VAR_EXISTS'];
});

await testAsync('requires_env: missing → issue reported', async () => {
  delete process.env['DEFINITELY_NOT_SET_XYZ123'];
  const { cortex } = makeFakeCortex([], {
    'my-server': { requires_env: ['DEFINITELY_NOT_SET_XYZ123'] },
  });
  const result = await cortex.resolveDependencies('my-server');
  assertEqual(result.resolved, false, 'not resolved');
  assertEqual(result.issues.length, 1, 'one issue');
  assert(result.issues[0].includes('DEFINITELY_NOT_SET_XYZ123'), 'issue mentions var name');
});

await testAsync('requires_server: already running → no issue', async () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'dep-server' })],
    { 'my-server': { requires_server: ['dep-server'] } },
    [makeState({ name: 'dep-server', state: ConnectionState.IDLE })],
  );
  const result = await cortex.resolveDependencies('my-server');
  assertEqual(result.resolved, true, 'resolved');
});

await testAsync('requires_server: spawn fails → reports issue', async () => {
  const configs = [makeConfig({ name: 'dep-server' })];
  const { cortex, cm } = makeFakeCortex(
    configs,
    { 'my-server': { requires_server: ['dep-server'] } },
    [makeState({ name: 'dep-server', state: ConnectionState.FAILED })],
  );
  cm.setSpawnFail('dep-server');
  const result = await cortex.resolveDependencies('my-server');
  assertEqual(result.resolved, false, 'not resolved');
  assert(result.issues.length > 0, 'has issues');
  assert(result.issues[0].includes('dep-server'), 'issue mentions dependency name');
});

await testAsync('requires_service: unreachable → issue reported', async () => {
  const { cortex } = makeFakeCortex([], {
    'ghidra': { requires_service: [{ check: 'http://127.0.0.1:19999/check', name: 'Ghidra headless' }] },
  });
  const result = await cortex.resolveDependencies('ghidra');
  assertEqual(result.resolved, false, 'not resolved');
  assert(result.issues[0].includes('Ghidra headless'), 'issue mentions service name');
});

await testAsync('multiple dependency types combined', async () => {
  delete process.env['MULTI_DEP_TEST'];
  const { cortex } = makeFakeCortex([], {
    'complex-server': {
      requires_env: ['MULTI_DEP_TEST'],
      requires_service: [{ check: 'http://127.0.0.1:19998/health', name: 'svc-a' }],
    },
  });
  const result = await cortex.resolveDependencies('complex-server');
  assertEqual(result.resolved, false, 'not resolved');
  assert(result.issues.length >= 2, 'at least 2 issues');
});

await testAsync('circular A→B→A → detected, not infinite loop', async () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'a' }), makeConfig({ name: 'b' })],
    { 'a': { requires_server: ['b'] }, 'b': { requires_server: ['a'] } },
    [makeState({ name: 'a', state: ConnectionState.FAILED }), makeState({ name: 'b', state: ConnectionState.FAILED })],
  );
  const result = await cortex.resolveDependencies('a');
  assertEqual(result.resolved, false, 'not resolved');
  assert(result.issues.some(i => i.toLowerCase().includes('circular')), 'mentions circular');
});

await testAsync('self-loop A→A → detected', async () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'a' })],
    { 'a': { requires_server: ['a'] } },
    [makeState({ name: 'a', state: ConnectionState.FAILED })],
  );
  const result = await cortex.resolveDependencies('a');
  assertEqual(result.resolved, false, 'not resolved');
  assert(result.issues.some(i => i.toLowerCase().includes('circular')), 'mentions circular');
});

await testAsync('transitive A→B→C resolved in order', async () => {
  const { cortex, cm } = makeFakeCortex(
    [makeConfig({ name: 'a' }), makeConfig({ name: 'b' }), makeConfig({ name: 'c' })],
    { 'a': { requires_server: ['b'] }, 'b': { requires_server: ['c'] } },
    [
      makeState({ name: 'a', state: ConnectionState.FAILED }),
      makeState({ name: 'b', state: ConnectionState.FAILED }),
      makeState({ name: 'c', state: ConnectionState.FAILED }),
    ],
  );
  const result = await cortex.resolveDependencies('a');
  assertEqual(result.resolved, true, 'resolved');
  const started = cm.getStarted();
  assert(started.indexOf('c') < started.indexOf('b'), 'c started before b');
});

await testAsync('requires_server: failed server → auto-started via spawn', async () => {
  const configs = [makeConfig({ name: 'dep-server' })];
  const { cortex, cm } = makeFakeCortex(
    configs,
    { 'my-server': { requires_server: ['dep-server'] } },
    [makeState({ name: 'dep-server', state: ConnectionState.FAILED })],
  );
  const result = await cortex.resolveDependencies('my-server');
  assertEqual(result.resolved, true, 'resolved');
  assert(cm.getStarted().includes('dep-server'), 'dep-server was spawned');
});

// ─── 2. shouldRouteViaVM ─────────────────────────────────────────────────────

console.log('\nCortex Dependency Graph: shouldRouteViaVM Tests\n');

test('no sandbox, no intent, low restart count → false', () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'safe-server' })],
    {},
    [makeState({ name: 'safe-server', restartCount: 0 })],
  );
  assertEqual(cortex.shouldRouteViaVM('safe-server'), false, 'no VM routing');
});

test('sandbox configured → true', () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'sandboxed', sandbox: '/path/to/profile.json' })],
  );
  assertEqual(cortex.shouldRouteViaVM('sandboxed'), true, 'VM routing for sandbox');
});

test('risky intent keyword "untrusted" → true', () => {
  const { cortex } = makeFakeCortex([makeConfig({ name: 'server-a' })]);
  assertEqual(cortex.shouldRouteViaVM('server-a', 'analyze untrusted binary'), true, 'untrusted triggers VM');
});

test('risky intent keyword "malware" → true', () => {
  const { cortex } = makeFakeCortex([makeConfig({ name: 'server-a' })]);
  assertEqual(cortex.shouldRouteViaVM('server-a', 'scan for malware signatures'), true, 'malware triggers VM');
});

test('risky intent keyword "suspicious" → true', () => {
  const { cortex } = makeFakeCortex([makeConfig({ name: 'server-a' })]);
  assertEqual(cortex.shouldRouteViaVM('server-a', 'inspect suspicious payload'), true, 'suspicious triggers VM');
});

test('safe intent → false', () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'server-a' })],
    {},
    [makeState({ name: 'server-a', restartCount: 0 })],
  );
  assertEqual(cortex.shouldRouteViaVM('server-a', 'list all tables'), false, 'safe intent no VM');
});

test('restart count >= 3 (quarantine) → true', () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'flaky-server' })],
    {},
    [makeState({ name: 'flaky-server', restartCount: 3 })],
  );
  assertEqual(cortex.shouldRouteViaVM('flaky-server'), true, 'quarantine triggers VM');
});

test('restart count = 2 → false', () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'flaky-server' })],
    {},
    [makeState({ name: 'flaky-server', restartCount: 2 })],
  );
  assertEqual(cortex.shouldRouteViaVM('flaky-server'), false, 'not yet quarantined');
});

test('unknown server (not in configs, not in states) → false', () => {
  const { cortex } = makeFakeCortex();
  assertEqual(cortex.shouldRouteViaVM('nonexistent'), false, 'unknown server no VM');
});

test('case-insensitive intent matching', () => {
  const { cortex } = makeFakeCortex([makeConfig({ name: 'server-a' })]);
  assertEqual(cortex.shouldRouteViaVM('server-a', 'UNTRUSTED INPUT'), true, 'case insensitive');
  assertEqual(cortex.shouldRouteViaVM('server-a', 'Malware Analysis'), true, 'case insensitive malware');
});

// ─── 3. Config parsing (ServerDependency type) ──────────────────────────────

console.log('\nCortex Dependency Graph: Config Tests\n');

await testAsync('loadConfig parses dependencies section', async () => {
  const { loadConfig } = await import('../config.js');
  // loadConfig with no file returns empty dependencies
  const config = loadConfig('/nonexistent/path.json', true);
  assert('dependencies' in config, 'config has dependencies field');
  assertEqual(typeof config.dependencies, 'object', 'dependencies is object');
  assertEqual(Object.keys(config.dependencies).length, 0, 'empty dependencies');
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
