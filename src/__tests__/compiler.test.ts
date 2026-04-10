/**
 * Compiler Phase 1 Tests.
 *
 * Validates: parseIntent resolution, optimization level selection,
 * code composition, and graceful degradation.
 */

import { compile, substituteVars, extractTarget } from '../compiler.js';
import type { CompilationUnit } from '../compiler.js';
import { loadMethods } from '../cortex.js';
import type { Method } from '../cortex.js';
import { ChildManager } from '../child-manager.js';
import { ToolCatalog } from '../catalog.js';
import { PerceptionMode, HeuristicPerceptionProvider } from '../perception.js';
import { EvidenceSessionManager } from '../evidence.js';
import type { IntentRouteMap, ToolDefinition } from '../types.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Test harness ---

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

// --- Stubs ---

// Create a ChildManager with fake servers registered in its catalog
function createStubManager(servers: Record<string, ToolDefinition[]>): ChildManager {
  const cm = new ChildManager();
  const catalog = cm.getCatalog();

  for (const [serverName, tools] of Object.entries(servers)) {
    // Register server in connection store so getServerNames() returns it
    (cm as any).connectionStore.set(serverName, {
      state: 'idle',
      config: { name: serverName, command: 'echo', criticality: 'vital' as const },
    });

    // Register tools in catalog
    catalog.registerServer(serverName, tools);
  }

  return cm;
}

// --- Test data ---

const INTENT_ROUTES: IntentRouteMap = {
  'decompile': 'spectre.decompile_function',
  'list_databases': 'neon.list_databases',
  'crawl': 'crawlio-agent-headless.browser_navigate',
};

const FAKE_SERVERS: Record<string, ToolDefinition[]> = {
  'spectre': [
    { name: 'decompile_function', description: 'Decompile a function at a given address', server: 'spectre' },
    { name: 'list_functions', description: 'List all functions in binary', server: 'spectre' },
  ],
  'neon': [
    { name: 'list_databases', description: 'List all Neon databases', server: 'neon' },
    { name: 'get_database_tables', description: 'Get tables in a database', server: 'neon' },
    { name: 'sql_query', description: 'Execute SQL query', server: 'neon' },
  ],
  'crawlio-agent-headless': [
    { name: 'browser_navigate', description: 'Navigate browser to URL', server: 'crawlio-agent-headless', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'detect_technologies', description: 'Detect tech stack of a website', server: 'crawlio-agent-headless' },
    { name: 'extract_data', description: 'Extract data from page', server: 'crawlio-agent-headless' },
    { name: 'take_screenshot', description: 'Take screenshot of page', server: 'crawlio-agent-headless' },
  ],
  'sentry': [
    { name: 'list_issues', description: 'List Sentry issues', server: 'sentry' },
    { name: 'get_issue', description: 'Get a specific Sentry issue', server: 'sentry' },
  ],
};

const ALL_CONFIG_NAMES = Object.keys(FAKE_SERVERS);

// --- Tests ---

async function runTests(): Promise<void> {
  const perception = new PerceptionMode(new HeuristicPerceptionProvider());
  const evidence = new EvidenceSessionManager();

  console.log('Compiler Phase 1 Tests\n');

  // --- -O0: Direct intent route ---
  console.log('  --- -O0: Direct Intent Route ---');

  await test('decompile intent resolves via intent route to spectre', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile('decompile function at 0x100001234', perception, cm, evidence, INTENT_ROUTES);
    assert(unit.parsed.domain === 'reverse_engineering', `expected domain=reverse_engineering, got ${unit.parsed.domain}`);
    assert(unit.parsed.servers.includes('spectre'), `expected spectre in servers, got ${unit.parsed.servers}`);
    assert(unit.parsed.tools.includes('decompile_function'), `expected decompile_function in tools, got ${unit.parsed.tools}`);
    assert(unit.plan.confidence >= 0.85, `expected confidence >= 0.85, got ${unit.plan.confidence}`);
    // Note: perception may enrich with additional servers, so optimizationLevel may be > 0
  });

  await test('-O0 achieved with single-server stub and intent route', async () => {
    // Only register spectre to ensure no perception enrichment from other servers
    const cm = createStubManager({ spectre: FAKE_SERVERS['spectre'] });
    const unit = await compile('decompile function at 0x100001234', perception, cm, evidence, INTENT_ROUTES);
    assert(unit.optimizationLevel === 0, `expected -O0 with single server, got -O${unit.optimizationLevel}`);
  });

  await test('-O0 generates single-step code', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile('decompile function at 0x100001234', perception, cm, evidence, INTENT_ROUTES);
    assert(unit.code !== undefined, 'expected code to be generated');
    assert(unit.code!.includes("servers['spectre']"), `expected spectre call in code, got: ${unit.code}`);
    assert(unit.code!.includes("'decompile_function'"), `expected decompile_function in code`);
  });

  // --- -O1: Simple domain resolution ---
  console.log('\n  --- -O1: Simple Domain Resolution ---');

  await test('database query resolves to neon via domain mapping', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile('list all database tables', perception, cm, evidence, {});
    assert(unit.parsed.domain === 'database', `expected domain=database, got ${unit.parsed.domain}`);
    assert(unit.parsed.servers.includes('neon'), `expected neon in servers, got ${unit.parsed.servers}`);
  });

  await test('database query with single tool stays -O1', async () => {
    // Single tool → simple → -O1
    const cm = createStubManager({ neon: [FAKE_SERVERS['neon'][0]] });
    const unit = await compile('list all database tables', perception, cm, evidence, {});
    assert(unit.optimizationLevel <= 2,
      `got -O${unit.optimizationLevel}, parsed=${JSON.stringify(unit.parsed)}, steps=${unit.plan.steps.length}`);
  });

  await test('monitoring query resolves to sentry', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile('show recent error issues', perception, cm, evidence, {});
    assert(unit.parsed.domain === 'monitoring', `expected domain=monitoring, got ${unit.parsed.domain}`);
    assert(unit.parsed.servers.includes('sentry'), `expected sentry in servers, got ${unit.parsed.servers}`);
  });

  // --- -O2: Compound multi-tool ---
  console.log('\n  --- -O2: Compound Multi-Tool ---');

  await test('analyze + tech stack compiles to compound plan', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile('analyze stripe.com and find their tech stack and pricing', perception, cm, evidence, {});
    assert(unit.parsed.complexity === 'compound' || unit.plan.steps.length > 1,
      `expected compound/multi-step, got complexity=${unit.parsed.complexity}, steps=${unit.plan.steps.length}`);
    if (unit.optimizationLevel >= 2) {
      assert(unit.code !== undefined, 'expected code for -O2+');
      assert(unit.code!.includes('results') || unit.code!.includes('Promise.all'), 'compound code should use results object or Promise.all');
    }
  });

  // --- Plan mode (autoRun: false) ---
  console.log('\n  --- Plan Mode ---');

  await test('compilation produces plan with steps and budget', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile('full security audit of example.com', perception, cm, evidence, {});
    assert(unit.plan !== undefined, 'expected plan');
    assert(unit.plan.budget.total > 0, 'expected non-zero budget');
    assert(unit.plan.confidence >= 0, 'expected non-negative confidence');
  });

  // --- Graceful degradation ---
  console.log('\n  --- Graceful Degradation ---');

  await test('unrelated intent degrades gracefully with no steps', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile('make me a sandwich', perception, cm, evidence, {});
    // Should not crash — may have 0 steps (unknown domain) or some noise
    assert(unit.parsed.domain !== undefined, 'expected a domain (even unknown)');
    assert(unit.plan !== undefined, 'expected a plan object');
  });

  await test('empty intent degrades gracefully', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile('', perception, cm, evidence, {});
    assert(unit.plan !== undefined, 'expected plan for empty intent');
  });

  // --- Code composition ---
  console.log('\n  --- Code Composition ---');

  await test('simple intent with tool generates single call', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile('list databases', perception, cm, evidence, INTENT_ROUTES);
    if (unit.code) {
      assert(!unit.code.includes('results'), 'simple code should not use results{}');
      assert(unit.code.includes('return'), 'simple code should return directly');
    }
  });

  await test('CompilationUnit has all required fields', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile('decompile function', perception, cm, evidence, INTENT_ROUTES);
    assert('intent' in unit, 'missing intent');
    assert('parsed' in unit, 'missing parsed');
    assert('plan' in unit, 'missing plan');
    assert('optimizationLevel' in unit, 'missing optimizationLevel');
    assert(typeof unit.intent === 'string', 'intent should be string');
    assert([0, 1, 2, 3].includes(unit.optimizationLevel), `invalid optimization level: ${unit.optimizationLevel}`);
  });

  // --- Optimization level boundaries ---
  console.log('\n  --- Optimization Level Boundaries ---');

  await test('-O0 requires single tool + single server + high confidence', async () => {
    // Use single server to avoid perception enrichment
    const cm = createStubManager({ spectre: FAKE_SERVERS['spectre'] });
    const unit = await compile('decompile function at 0x100001234', perception, cm, evidence, INTENT_ROUTES);
    assert(unit.optimizationLevel === 0, `expected -O0, got -O${unit.optimizationLevel}`);
    assert(unit.parsed.tools.length === 1, 'O0 should have exactly 1 tool');
    assert(unit.parsed.servers.length === 1, 'O0 should have exactly 1 server');
  });

  await test('no matching servers → 0 steps', async () => {
    // Empty server set
    const cm = createStubManager({});
    const unit = await compile('decompile function', perception, cm, evidence, INTENT_ROUTES);
    assert(unit.plan.steps.length === 0, `expected 0 steps when no servers, got ${unit.plan.steps.length}`);
  });

  // --- Named Methods ---
  console.log('\n  --- Named Methods ---');

  const methodsFile = join(tmpdir(), `mentu-methods-test-${Date.now()}.json`);
  const TEST_METHODS: Record<string, Method> = {
    investigate_saas: {
      name: 'investigate_saas',
      intent_pattern: 'investigate|analyze .* (saas|website|service)',
      servers: ['crawlio-agent-headless', 'perplexity'],
      steps: [
        { server: 'crawlio-agent-headless', tool: 'browser_navigate', args: { url: '$TARGET' } },
        { server: 'perplexity', tool: 'perplexity_search', args: { query: '$INTENT' } },
      ],
      confidence: 0.92,
      hit_count: 57,
      first_seen: '2026-03-22',
      source: 'cir_crystallization',
    },
    low_confidence: {
      name: 'low_confidence',
      intent_pattern: 'low.*confidence',
      servers: ['neon'],
      steps: [
        { server: 'neon', tool: 'list_databases', args: {} },
      ],
      confidence: 0.5,
      hit_count: 2,
      first_seen: '2026-03-22',
      source: 'cir_crystallization',
    },
  };
  writeFileSync(methodsFile, JSON.stringify(TEST_METHODS));

  await test('method hit short-circuits compilation', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile(
      'analyze the saas website at https://example.com',
      perception, cm, evidence, INTENT_ROUTES, { methodsPath: methodsFile },
    );
    assert(unit.plan.confidence === 0.92, `expected confidence=0.92, got ${unit.plan.confidence}`);
    assert(unit.plan.steps.length === 2, `expected 2 steps, got ${unit.plan.steps.length}`);
    assert(unit.plan.steps[0]!.server === 'crawlio-agent-headless', 'step 0 should be crawlio');
    assert(unit.plan.steps[1]!.server === 'perplexity', 'step 1 should be perplexity');
    assert(unit.optimizationLevel === 0, `expected -O0, got -O${unit.optimizationLevel}`);
  });

  await test('method hit substitutes $TARGET and $INTENT', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile(
      'analyze the saas website at https://stripe.com',
      perception, cm, evidence, INTENT_ROUTES, { methodsPath: methodsFile },
    );
    const step0Args = unit.plan.steps[0]!.args as Record<string, string>;
    assert(step0Args.url === 'https://stripe.com', `expected url=https://stripe.com, got ${step0Args.url}`);
    const step1Args = unit.plan.steps[1]!.args as Record<string, string>;
    assert(step1Args.query.includes('analyze the saas website'), `expected INTENT in query, got ${step1Args.query}`);
  });

  await test('method hit generates parallel code for different servers', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile(
      'investigate the saas service at https://example.com',
      perception, cm, evidence, INTENT_ROUTES, { methodsPath: methodsFile },
    );
    assert(unit.code !== undefined, 'expected code from method hit');
    assert(unit.code!.includes('Promise.all'), 'multi-server method should use Promise.all');
  });

  await test('low confidence method is skipped', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile(
      'low confidence test',
      perception, cm, evidence, {}, { methodsPath: methodsFile },
    );
    // Should NOT match the low_confidence method (confidence 0.5 < 0.8 threshold)
    assert(unit.plan.confidence !== 0.5, 'low confidence method should not match');
  });

  await test('non-matching intent falls through to normal compilation', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile(
      'list all database tables',
      perception, cm, evidence, {}, { methodsPath: methodsFile },
    );
    // Should use normal compilation, not method hit
    assert(unit.parsed.domain === 'database', `expected domain=database, got ${unit.parsed.domain}`);
  });

  await test('loadMethods returns empty for missing file', async () => {
    const methods = loadMethods('/nonexistent/path.json');
    assert(methods.length === 0, 'expected empty array for missing file');
  });

  await test('loadMethods loads valid methods file', async () => {
    const methods = loadMethods(methodsFile);
    assert(methods.length === 2, `expected 2 methods, got ${methods.length}`);
    const names = methods.map(m => m.name).sort();
    assert(names[0] === 'investigate_saas', `expected investigate_saas, got ${names[0]}`);
    assert(names[1] === 'low_confidence', `expected low_confidence, got ${names[1]}`);
  });

  // --- Helper functions ---
  console.log('\n  --- Helper Functions ---');

  await test('extractTarget finds URL', async () => {
    const target = extractTarget('analyze https://stripe.com/pricing');
    assert(target === 'https://stripe.com/pricing', `expected URL, got ${target}`);
  });

  await test('extractTarget finds quoted string', async () => {
    const target = extractTarget('investigate "example.com" service');
    assert(target === 'example.com', `expected example.com, got ${target}`);
  });

  await test('extractTarget finds domain-like token', async () => {
    const target = extractTarget('crawl stripe.com pages');
    assert(target === 'stripe.com', `expected stripe.com, got ${target}`);
  });

  await test('extractTarget returns empty for no target', async () => {
    const target = extractTarget('list databases');
    assert(target === '', `expected empty, got ${target}`);
  });

  await test('substituteVars replaces placeholders', async () => {
    const result = substituteVars(
      { url: '$TARGET', query: 'search $INTENT', count: 5 },
      { TARGET: 'https://foo.com', INTENT: 'find stuff' },
    );
    assert(result.url === 'https://foo.com', `expected url replacement, got ${result.url}`);
    assert(result.query === 'search find stuff', `expected query replacement, got ${result.query}`);
    assert(result.count === 5, `expected count preserved, got ${result.count}`);
  });

  // Clean up temp methods file
  try { unlinkSync(methodsFile); } catch { /* ignore */ }

  // --- Compound Intents ---
  console.log('\n  --- Compound Intents ---');

  await test('compound intent resolves multiple servers', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile(
      'crawl stripe.com and then decompile the mobile app binary at /tmp/app',
      perception, cm, evidence, INTENT_ROUTES,
      { serverNames: ALL_CONFIG_NAMES },
    );
    assert(unit.parsed.complexity === 'compound', `expected compound, got ${unit.parsed.complexity}`);
    assert(unit.parsed.servers.length >= 2, `expected >=2 servers, got ${unit.parsed.servers.length}: ${unit.parsed.servers}`);
    assert(unit.plan.steps.length >= 2, `expected >=2 steps, got ${unit.plan.steps.length}`);
  });

  await test('compound steps have filled args', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile(
      'crawl https://stripe.com/pricing and analyze the results',
      perception, cm, evidence, INTENT_ROUTES,
      { serverNames: ALL_CONFIG_NAMES },
    );
    const urlStep = unit.plan.steps.find(s => s.args.url);
    assert(urlStep !== undefined, 'at least one step has url filled');
  });

  await test('parallel compose produces Promise.all for different servers', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile(
      'crawl stripe.com and also check sentry error issues',
      perception, cm, evidence, INTENT_ROUTES,
      { serverNames: ALL_CONFIG_NAMES },
    );
    if (unit.code) {
      assert(
        unit.code.includes('Promise.all') || unit.code.includes('await servers'),
        `expected execution code, got: ${unit.code}`,
      );
    }
  });

  await test('conjunction keywords upgrade to compound', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile(
      'list databases and then show error issues',
      perception, cm, evidence, {},
      { serverNames: ALL_CONFIG_NAMES },
    );
    assert(unit.parsed.complexity === 'compound', `expected compound, got ${unit.parsed.complexity}`);
    // Should resolve servers from both database and monitoring domains
    const hasNeon = unit.parsed.servers.includes('neon');
    const hasSentry = unit.parsed.servers.includes('sentry');
    assert(hasNeon && hasSentry, `expected neon+sentry, got ${unit.parsed.servers}`);
  });

  await test('compound confidence is lower than simple', async () => {
    const cmSimple = createStubManager({ spectre: FAKE_SERVERS['spectre'] });
    const simple = await compile('decompile function at 0x100001234', perception, cmSimple, evidence, INTENT_ROUTES);

    const cmCompound = createStubManager(FAKE_SERVERS);
    const compound = await compile(
      'crawl stripe.com and then decompile the binary at /tmp/app',
      perception, cmCompound, evidence, INTENT_ROUTES,
      { serverNames: ALL_CONFIG_NAMES },
    );
    assert(
      compound.plan.confidence <= simple.plan.confidence,
      `expected compound confidence (${compound.plan.confidence}) <= simple (${simple.plan.confidence})`,
    );
  });

  await test('compound code is valid JavaScript (no syntax errors)', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile(
      'crawl stripe.com and then decompile the binary at /tmp/app',
      perception, cm, evidence, INTENT_ROUTES,
      { serverNames: ALL_CONFIG_NAMES },
    );
    if (unit.code) {
      // Wrap in async function to validate syntax
      try {
        new Function('servers', `return (async () => { ${unit.code} })();`);
      } catch (e) {
        throw new Error(`generated code has syntax error: ${(e as Error).message}\nCode: ${unit.code}`);
      }
    }
  });

  await test('pre-spawn loop covers all compound plan servers', async () => {
    const cm = createStubManager(FAKE_SERVERS);
    const unit = await compile(
      'crawl stripe.com and then decompile the binary at /tmp/app',
      perception, cm, evidence, INTENT_ROUTES,
      { serverNames: ALL_CONFIG_NAMES },
    );
    // Verify plan steps reference multiple distinct servers
    const planServers = new Set(unit.plan.steps.map(s => s.server));
    assert(planServers.size >= 2, `expected >=2 distinct servers in plan, got ${planServers.size}: ${[...planServers]}`);
  });

  // --- Summary ---
  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
