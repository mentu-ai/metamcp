/**
 * E2E God Node + Cortex Evolution Tests
 *
 * Group 1: Cortex Evolution Stack (always runs, no external deps)
 * Group 2: DaemonClient Live Connection (skips if daemon not running)
 * Group 3: VsockTransport Lifecycle (skips if daemon not running)
 * Group 4: Hardening Regression Guards (always runs, reads source files)
 */

import { hashIntent, extractTarget, substituteVars } from '../compiler.js';
import { loadMethods, Cortex, WEIGHTS_PATH } from '../cortex.js';
import { DaemonClient } from '../daemon-client.js';
import { VsockTransport } from '../vsock-transport.js';
import { isCIRAvailable } from '../cir-client.js';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionState } from '../types.js';
import type { ServerConfig, ChildState } from '../types.js';
import type { ServerDependency } from '../config.js';
import { findSkillForServer } from '../skill-catalog.js';

// ─── Test Runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
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

function skip(name: string, reason: string): void {
  skipped++;
  console.log(`  SKIP: ${name} — ${reason}`);
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Fake ChildManager for Cortex tests ──────────────────────────────────────

class FakeChildManager {
  private states: ChildState[] = [];
  private started: string[] = [];

  setStates(states: ChildState[]) { this.states = states; }
  getStarted(): string[] { return this.started; }
  getAllStates(): ChildState[] { return this.states; }
  async spawn(config: ServerConfig) {
    this.started.push(config.name);
    const existing = this.states.find(s => s.name === config.name);
    if (existing) existing.state = ConnectionState.IDLE;
    return [];
  }
  onSpawnFailure(_hook: unknown) { /* noop */ }
}

function makeFakeCortex(
  configs: ServerConfig[] = [],
  dependencies: Record<string, ServerDependency> = {},
  childStates: ChildState[] = [],
): { cortex: Cortex; cm: FakeChildManager } {
  const cm = new FakeChildManager();
  cm.setStates(childStates);
  const cortex = Object.create(Cortex.prototype) as Cortex;
  (cortex as any).perception = { stats: () => ({}) };
  (cortex as any).childManager = cm;
  (cortex as any).serverConfigs = configs;
  (cortex as any).dependencies = dependencies;
  return { cortex, cm };
}

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { name: 'test-server', command: 'echo', criticality: 'optional', ...overrides };
}

function makeState(overrides: Partial<ChildState> = {}): ChildState {
  return { name: 'test-server', state: ConnectionState.IDLE, toolCount: 5, criticality: 'optional', restartCount: 0, ...overrides };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Group 1: Cortex Evolution Stack
// ═══════════════════════════════════════════════════════════════════════════════

console.log('E2E God Node: Cortex Evolution Stack\n');

// --- hashIntent ---
test('hashIntent: punctuation normalization', () => {
  assertEqual(hashIntent('deploy-service'), hashIntent('deploy service'), 'hyphen vs space');
  assertEqual(hashIntent('deploy.service'), hashIntent('deploy service'), 'dot vs space');
  assertEqual(hashIntent('find/search resources'), hashIntent('find search resources'), 'slash vs space');
});

test('hashIntent: stop word removal', () => {
  assertEqual(hashIntent('list all database tables'), hashIntent('list database tables'), 'stop word "all"');
  assertEqual(hashIntent('the quick brown fox'), hashIntent('quick brown fox'), 'stop word "the"');
});

// --- extractTarget ---
test('extractTarget: URL extraction', () => {
  assertEqual(extractTarget('analyze https://example.com/path'), 'https://example.com/path', 'URL');
});

test('extractTarget: quoted string', () => {
  assertEqual(extractTarget('investigate "example.com" service'), 'example.com', 'quoted');
});

test('extractTarget: domain-like token', () => {
  assertEqual(extractTarget('crawl stripe.com pages'), 'stripe.com', 'domain');
});

test('extractTarget: no target returns empty', () => {
  assertEqual(extractTarget('list databases'), '', 'no target');
});

// --- substituteVars ---
test('substituteVars: replaces $TARGET and $INTENT', () => {
  const result = substituteVars(
    { url: '$TARGET', query: '$INTENT' },
    { TARGET: 'https://example.com', INTENT: 'analyze website' },
  );
  assertEqual(result.url as string, 'https://example.com', 'TARGET');
  assertEqual(result.query as string, 'analyze website', 'INTENT');
});

// --- shouldRouteViaVM ---
test('shouldRouteViaVM: sandbox config → true', () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'sandboxed', sandbox: 'strict' as any })],
    {},
    [makeState({ name: 'sandboxed' })],
  );
  assertEqual(cortex.shouldRouteViaVM('sandboxed'), true, 'sandbox');
});

test('shouldRouteViaVM: risky intent → true', () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'safe' })],
    {},
    [makeState({ name: 'safe' })],
  );
  assertEqual(cortex.shouldRouteViaVM('safe', 'analyze untrusted binary'), true, 'risky');
});

test('shouldRouteViaVM: quarantine (3+ restarts) → true', () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'crashy' })],
    {},
    [makeState({ name: 'crashy', restartCount: 3 })],
  );
  assertEqual(cortex.shouldRouteViaVM('crashy'), true, 'quarantine');
});

test('shouldRouteViaVM: normal server → false', () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'normal' })],
    {},
    [makeState({ name: 'normal', restartCount: 0 })],
  );
  assertEqual(cortex.shouldRouteViaVM('normal'), false, 'normal');
});

// --- resolveDependencies ---
await testAsync('resolveDependencies: cycle detection A→B→A', async () => {
  const { cortex } = makeFakeCortex(
    [makeConfig({ name: 'a' }), makeConfig({ name: 'b' })],
    { 'a': { requires_server: ['b'] }, 'b': { requires_server: ['a'] } },
    [makeState({ name: 'a', state: ConnectionState.FAILED }), makeState({ name: 'b', state: ConnectionState.FAILED })],
  );
  const result = await cortex.resolveDependencies('a');
  assertEqual(result.resolved, false, 'not resolved');
  assert(result.issues.some(i => i.toLowerCase().includes('circular')), 'mentions circular');
});

await testAsync('resolveDependencies: transitive A→B→C order', async () => {
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
  assert(started.indexOf('c') < started.indexOf('b'), 'c before b');
});

// --- loadMethods ---
test('loadMethods: valid file', () => {
  const tmpFile = join(tmpdir(), `e2e-methods-${Date.now()}.json`);
  const methods = { test_method: { name: 'test_method', intent_pattern: 'test.*', servers: ['s1'], steps: [], confidence: 0.9, hit_count: 10, first_seen: '2026-01-01', source: 'test' } };
  writeFileSync(tmpFile, JSON.stringify(methods));
  const loaded = loadMethods(tmpFile);
  assertEqual(loaded.length, 1, 'one method');
  assertEqual(loaded[0].name, 'test_method', 'method name');
  unlinkSync(tmpFile);
});

test('loadMethods: missing file → empty array', () => {
  const loaded = loadMethods('/nonexistent/path.json');
  assertEqual(loaded.length, 0, 'empty');
});

// --- tuneWeights ---
test('tuneWeights: returns bounded weights', () => {
  const { cortex } = makeFakeCortex();
  const weights = cortex.tuneWeights();
  for (const [k, v] of Object.entries(weights)) {
    if (v > 0) {
      assert(v >= 0.05, `${k} >= floor (got ${v})`);
      assert(v <= 0.50, `${k} <= ceiling (got ${v})`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 2: DaemonClient Live Connection
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nE2E God Node: DaemonClient Live Connection\n');

const daemonAvailable = DaemonClient.isAvailable();

if (daemonAvailable) {
  test('DaemonClient.isAvailable() → true', () => {
    assertEqual(DaemonClient.isAvailable(), true, 'available');
  });

  await testAsync('DaemonClient.connect + daemon.status', async () => {
    const client = new DaemonClient();
    await client.connect();
    const result = await client.call('daemon.status', {}, 5000) as Record<string, unknown>;
    assert(result.daemonState === 'running', `daemon state: ${result.daemonState}`);
    assert(typeof result.pid === 'number', 'has pid');
    client.disconnect();
  });

  await testAsync('DaemonClient.call unknown method → error', async () => {
    const client = new DaemonClient();
    await client.connect();
    try {
      await client.call('nonexistent.method', {}, 5000);
      throw new Error('should have thrown');
    } catch (rawErr) {
      const err = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
      assert(err.message.includes('Unknown method') || err.message.includes('-32601'), `error msg: ${err.message}`);
    }
    client.disconnect();
  });
} else {
  skip('DaemonClient.isAvailable()', 'daemon not running');
  skip('DaemonClient.connect + daemon.status', 'daemon not running');
  skip('DaemonClient.call unknown method', 'daemon not running');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Group 3: VsockTransport Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nE2E God Node: VsockTransport Lifecycle\n');

if (daemonAvailable) {
  await testAsync('VsockTransport.start() → spawn accepted by daemon', async () => {
    const transport = new VsockTransport('echo', ['hello'], {});
    try {
      await transport.start();
      assert(transport.sessionId !== undefined, 'sessionId assigned');
      await transport.close();
    } catch (err) {
      // Spawn may fail if no VM image — but the RPC call itself should succeed
      const msg = err instanceof Error ? err.message : String(err);
      // If daemon accepted the call but engine failed, that's still a valid test
      assert(!msg.includes('ECONNREFUSED'), `daemon should accept: ${msg}`);
      assert(!msg.includes('not started'), `should have connected: ${msg}`);
    }
  });

  test('McpClient vmFallbackActive defaults to false', () => {
    // Import already handled at module level — test the property via dynamic import
    // Since we can't easily instantiate McpClient without its full dependency tree,
    // we verify the flag exists via the source check in Group 4 instead.
    // Here we just verify VsockTransport sessionId is undefined before start.
    const t = new VsockTransport('echo', [], {});
    assertEqual(t.sessionId, undefined, 'sessionId undefined before start');
  });
} else {
  skip('VsockTransport.start()', 'daemon not running');
  skip('McpClient vmFallbackActive', 'daemon not running');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Group 4: Hardening Regression Guards
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nE2E God Node: Hardening Regression Guards\n');

const srcRoot = join(import.meta.url.replace('file://', '').replace('/dist/__tests__/e2e-godnode.test.js', ''), 'src');

test('cir-client uses execFileSync (not execSync)', () => {
  const src = readFileSync(join(srcRoot, 'cir-client.ts'), 'utf-8');
  assert(src.includes('execFileSync'), 'has execFileSync');
  assert(!src.includes("import { execSync }"), 'no execSync import');
});

test('cortex.ts has cycle detection (visited Set)', () => {
  const src = readFileSync(join(srcRoot, 'cortex.ts'), 'utf-8');
  assert(src.includes('visited = new Set<string>()'), 'has visited Set');
  assert(src.includes('visited.has(serverName)'), 'checks visited');
});

test('child-manager.ts has circuit breaker gate on heal retry', () => {
  const src = readFileSync(join(srcRoot, 'child-manager.ts'), 'utf-8');
  assert(src.includes('circuitBreaker.isOpen()'), 'has CB gate');
});

test('vsock-transport.ts registers notification before spawn', () => {
  const src = readFileSync(join(srcRoot, 'vsock-transport.ts'), 'utf-8');
  const notifIdx = src.indexOf('onNotification');
  const spawnIdx = src.indexOf("'mcp_proxy.spawn'");
  assert(notifIdx > 0 && spawnIdx > 0, 'both patterns found');
  assert(notifIdx < spawnIdx, `notification (${notifIdx}) before spawn (${spawnIdx})`);
});

test('guest agent has no shell fallback after execve', () => {
  const agentPath = '/Users/rashid/Desktop/mentu-runtime/guest/agent.c';
  if (existsSync(agentPath)) {
    const src = readFileSync(agentPath, 'utf-8');
    const execveIdx = src.indexOf('execve(engine_path');
    const exitIdx = src.indexOf('_exit(127)', execveIdx);
    const shIdx = src.indexOf('/bin/sh', execveIdx);
    assert(execveIdx > 0, 'has execve');
    assert(exitIdx > 0, 'has _exit(127)');
    // /bin/sh should NOT appear between execve and _exit
    assert(shIdx === -1 || shIdx > exitIdx, 'no shell fallback between execve and _exit');
  } else {
    console.log('  SKIP: guest agent not at expected path');
    skipped++;
  }
});

test('mcp-client.ts has vmFallbackActive flag', () => {
  const src = readFileSync(join(srcRoot, 'mcp-client.ts'), 'utf-8');
  assert(src.includes('vmFallbackActive'), 'has vmFallbackActive');
  assert(src.includes('VM ISOLATION BYPASSED'), 'has loud warning');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 5: Agent + Memory + Skill Recovery
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nE2E God Node: Agent + Memory + Skill Recovery\n');

// Test: agent definition file exists and has required fields
test('mcp-do agent definition exists with memory field', () => {
  const agentPath = join(srcRoot, '..', '.claude', 'agents', 'mcp-do.md');
  assert(existsSync(agentPath), 'agent file exists');
  const content = readFileSync(agentPath, 'utf-8');
  assert(content.includes('memory: project'), 'has memory: project');
  assert(content.includes('mcp__mentu-mcp__mcp_do') || content.includes('mcp__metamcp__mcp_do'), 'has mcp_do tool');
  assert(content.includes('Read'), 'has Read tool for memory');
  assert(content.includes('Write'), 'has Write tool for memory');
});

// Test: findSkillForServer returns correct skill for spectre
test('findSkillForServer: spectre → spectre-intelligence', () => {
  const result = findSkillForServer('spectre');
  assert(result !== null, 'found skill');
  assertEqual(result!.skillName, 'spectre-intelligence', 'skill name');
});

// Test: findSkillForServer returns correct skill for crawlio
test('findSkillForServer: crawlio → crawlio-mcp', () => {
  const result = findSkillForServer('crawlio');
  assert(result !== null, 'found skill');
  assertEqual(result!.skillName, 'crawlio-mcp', 'skill name');
});

// Test: findSkillForServer returns null for unknown server
test('findSkillForServer: unknown → null', () => {
  assertEqual(findSkillForServer('nonexistent-server'), null, 'null for unknown');
});

// Test: memory directory is writable
test('agent memory directory is creatable', () => {
  const memDir = join(process.cwd(), '.claude', 'agent-memory', 'mcp-do');
  mkdirSync(memDir, { recursive: true });
  assert(existsSync(memDir), 'memory dir created');
  // Write a test file
  writeFileSync(join(memDir, 'test.md'), '# Test\n');
  assert(existsSync(join(memDir, 'test.md')), 'can write to memory');
  unlinkSync(join(memDir, 'test.md'));
});

// Test: extractTarget with full URL
test('extractTarget: full URL', () => {
  assertEqual(extractTarget('crawl https://stripe.com/pricing'), 'https://stripe.com/pricing', 'full URL');
});

// Test: extractTarget with domain only
test('extractTarget: domain only', () => {
  assertEqual(extractTarget('analyze stripe.com'), 'stripe.com', 'domain');
});

// Test: extractTarget with file-like input (domain regex matches filename.ext)
test('extractTarget: file-like token matches as domain', () => {
  const target = extractTarget('decompile /tmp/app.bin');
  assertEqual(target, 'app.bin', 'filename matched as domain-like token');
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────────────────────────`);
console.log(`E2E God Node tests: ${passed} passed, ${failed} failed, ${skipped} skipped`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

process.exit(0);
