/**
 * E2E VM Pipeline Integration Tests
 *
 * Validates the full pipeline: intent registration -> mapping -> VM provider
 * -> engine execution -> result collection. Uses mocked fetch for runtime calls.
 */

import { IntentRegistry } from '../intent-registry.js';
import { IntentMapper } from '../intent-mapper.js';
import { isMultiEngine } from '../intent-types.js';
import { VMExecutionProvider } from '../vm-provider.js';
import type { AnalysisResult } from '../vm-provider.js';

// ─── Test Runner ─────────────────────────────────────────────────────────────

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

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

// ─── Mock Helpers ────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = handler as typeof globalThis.fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function jsonRpcResponse(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonRpcError(id: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.log('E2E VM Pipeline Tests\n');

  // ── Test 1: Intent Registration ──────────────────────────────────────────

  await test('1. Intent Registration: all 4 intents registered', async () => {
    const registry = new IntentRegistry();
    const names = ['analyze_binary', 'decompile_api', 'crawl_website', 'full_analysis'];
    for (const name of names) {
      assert(registry.has(name), `intent '${name}' not registered`);
    }
    assertEqual(registry.all().length, 4, 'total intent count');
  });

  await test('1b. Intent Registration: schemas are valid objects', async () => {
    const registry = new IntentRegistry();
    for (const intent of registry.all()) {
      assert(typeof intent.inputSchema === 'object' && intent.inputSchema !== null,
        `${intent.toolName}: inputSchema must be an object`);
      assertEqual((intent.inputSchema as Record<string, unknown>).type, 'object',
        `${intent.toolName}: inputSchema.type`);
      assert('properties' in intent.inputSchema,
        `${intent.toolName}: inputSchema must have properties`);
    }
  });

  await test('1c. Intent Registration: descriptions are non-empty', async () => {
    const registry = new IntentRegistry();
    for (const intent of registry.all()) {
      assert(typeof intent.description === 'string' && intent.description.length > 0,
        `${intent.toolName}: description must be non-empty`);
    }
  });

  await test('1d. IntentMapper exposes tool definitions', async () => {
    const mapper = new IntentMapper();
    const defs = mapper.toolDefinitions;
    assertEqual(defs.length, 4, 'tool definition count');
    for (const def of defs) {
      assert(typeof def.name === 'string' && def.name.length > 0, 'name must be non-empty');
      assert(typeof def.description === 'string' && def.description.length > 0, 'description must be non-empty');
      assert(typeof def.inputSchema === 'object', 'inputSchema must be object');
    }
  });

  // ── Test 2: Intent Mapping — analyze_binary ──────────────────────────────

  await test('2. Intent Mapping: analyze_binary -> Spectre engine', async () => {
    const mapper = new IntentMapper();
    const result = mapper.map('analyze_binary', { path: '/tmp/test.ipa' });

    assertEqual(result.requests.length, 1, 'single request');
    assertEqual(result.requests[0].engine, 'spectre', 'engine');
    assertDeepEqual(result.requests[0].inputFiles, ['/tmp/test.ipa'], 'inputFiles');
  });

  await test('2b. Intent Mapping: analyze_binary includes default args', async () => {
    const mapper = new IntentMapper();
    const result = mapper.map('analyze_binary', { path: '/tmp/test.ipa' });

    assert(result.requests[0].engineArgs!.includes('--format'), 'includes --format flag');
    assert(result.requests[0].engineArgs!.includes('json'), 'includes json value');
  });

  await test('2c. Intent Mapping: analyze_binary sets enableCortex=true', async () => {
    const mapper = new IntentMapper();
    const result = mapper.map('analyze_binary', { path: '/tmp/test.ipa' });

    assertEqual(result.requests[0].enableCortex, true, 'enableCortex');
    assertEqual(result.requests[0].enableInterception, false, 'enableInterception');
  });

  await test('2d. Intent Mapping: analyze_binary with outputFormat override', async () => {
    const mapper = new IntentMapper();
    const result = mapper.map('analyze_binary', { path: '/tmp/test.ipa', outputFormat: 'sarif' });

    const args = result.requests[0].engineArgs!;
    const formatIndex = args.lastIndexOf('--format');
    assert(formatIndex >= 0, 'has --format');
    assertEqual(args[formatIndex + 1], 'sarif', 'format override applied');
  });

  await test('2e. Intent Mapping: missing required param throws', async () => {
    const mapper = new IntentMapper();
    let threw = false;
    try {
      mapper.map('analyze_binary', {});
    } catch (err) {
      threw = true;
      assert(err instanceof Error && err.message.includes('path'), 'error mentions missing field');
    }
    assert(threw, 'should throw for missing required param');
  });

  await test('2f. Intent Mapping: unknown intent throws', async () => {
    const mapper = new IntentMapper();
    let threw = false;
    try {
      mapper.map('nonexistent_intent', {});
    } catch (err) {
      threw = true;
      assert(err instanceof Error && err.message.includes('Unknown intent'), 'error is about unknown intent');
    }
    assert(threw, 'should throw for unknown intent');
  });

  // ── Test 3: Multi-Engine Intent — full_analysis ──────────────────────────

  await test('3. Multi-Engine Intent: full_analysis produces 3 requests', async () => {
    const mapper = new IntentMapper();
    const result = mapper.map('full_analysis', { path: '/tmp/app.ipa' });

    assertEqual(result.requests.length, 3, 'request count');
    assertEqual(result.parallel.length, 3, 'parallel array length');
  });

  await test('3b. Multi-Engine Intent: correct engines', async () => {
    const mapper = new IntentMapper();
    const result = mapper.map('full_analysis', { path: '/tmp/app.ipa' });

    const engines = result.requests.map(r => r.engine);
    assert(engines.includes('spectre'), 'includes spectre');
    assert(engines.includes('crawlio'), 'includes crawlio');
    assert(engines.includes('interceptor'), 'includes interceptor');
  });

  await test('3c. Multi-Engine Intent: parallel flags set', async () => {
    const mapper = new IntentMapper();
    const result = mapper.map('full_analysis', { path: '/tmp/app.ipa' });

    // All steps in full_analysis are marked parallel=true
    for (let i = 0; i < result.parallel.length; i++) {
      assertEqual(result.parallel[i], true, `step ${i} parallel`);
    }
  });

  await test('3d. Multi-Engine Intent: decompile_api produces 2 requests', async () => {
    const mapper = new IntentMapper();
    const result = mapper.map('decompile_api', { path: '/tmp/app.ipa' });

    assertEqual(result.requests.length, 2, 'request count');
    assertEqual(result.requests[0].engine, 'interceptor', 'first engine');
    assertEqual(result.requests[1].engine, 'spectre', 'second engine');
    assertEqual(result.requests[0].enableInterception, true, 'interceptor has interception enabled');
  });

  await test('3e. Multi-Engine Intent: isMultiEngine type guard', async () => {
    const registry = new IntentRegistry();
    const single = registry.get('analyze_binary')!;
    const multi = registry.get('full_analysis')!;

    assertEqual(isMultiEngine(single), false, 'analyze_binary is single-engine');
    assertEqual(isMultiEngine(multi), true, 'full_analysis is multi-engine');
  });

  // ── Test 4: VM Provider Connection (mock) ────────────────────────────────

  await test('4. VM Provider: executeEngine sends correct JSON-RPC', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedUrl = '';

    mockFetch(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      const mockResult: AnalysisResult = {
        jobId: 'job-001',
        exitCode: 0,
        outputFiles: ['/tmp/out/report.json'],
        engineOutput: 'Analysis complete',
        engineErrors: '',
        durationMs: 1234,
      };
      return jsonRpcResponse(capturedBody.id as number, mockResult);
    });

    try {
      const provider = new VMExecutionProvider({ runtimeUrl: 'http://test:8400' });
      const result = await provider.executeEngine({
        engine: 'spectre',
        inputFiles: ['/tmp/test.ipa'],
        engineArgs: ['--format', 'json'],
        enableCortex: true,
      });

      assertEqual(capturedUrl, 'http://test:8400/rpc', 'RPC URL');
      assertEqual(capturedBody!.jsonrpc, '2.0', 'JSON-RPC version');
      assertEqual(capturedBody!.method, 'engine_bay.execute', 'method');
      assertEqual(typeof capturedBody!.id, 'number', 'id is number');

      const params = capturedBody!.params as Record<string, unknown>;
      assertEqual(params.engine, 'spectre', 'engine param');
      assertDeepEqual(params.input_files, ['/tmp/test.ipa'], 'input_files param');
      assertDeepEqual(params.engine_args, ['--format', 'json'], 'engine_args param');
      assertEqual(params.enable_cortex, true, 'enable_cortex param');
      assertEqual(params.enable_interception, false, 'enable_interception param');

      assertEqual(result.jobId, 'job-001', 'result jobId');
      assertEqual(result.exitCode, 0, 'result exitCode');
    } finally {
      restoreFetch();
    }
  });

  await test('4b. VM Provider: listEngines returns parsed response', async () => {
    mockFetch(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      assertEqual(body.method, 'engine_bay.list_engines', 'method');
      return jsonRpcResponse(body.id as number, [
        { name: 'spectre', version: '1.0.0', description: 'RE engine', capabilities: ['decompile'] },
        { name: 'crawlio', version: '2.0.0', description: 'Web crawler', capabilities: ['crawl'] },
      ]);
    });

    try {
      const provider = new VMExecutionProvider();
      const engines = await provider.listEngines();
      assertEqual(engines.length, 2, 'engine count');
      assertEqual(engines[0].name, 'spectre', 'first engine');
      assertEqual(engines[1].name, 'crawlio', 'second engine');
    } finally {
      restoreFetch();
    }
  });

  await test('4c. VM Provider: RPC error throws', async () => {
    mockFetch(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonRpcError(body.id as number, -32600, 'Engine not found');
    });

    try {
      const provider = new VMExecutionProvider();
      let threw = false;
      try {
        await provider.executeEngine({ engine: 'missing', inputFiles: ['/tmp/x'] });
      } catch (err) {
        threw = true;
        assert(err instanceof Error && err.message.includes('Engine not found'), 'error message');
      }
      assert(threw, 'should throw on RPC error');
    } finally {
      restoreFetch();
    }
  });

  await test('4d. VM Provider: HTTP error throws', async () => {
    mockFetch(async () => {
      return new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' });
    });

    try {
      const provider = new VMExecutionProvider();
      let threw = false;
      try {
        await provider.executeEngine({ engine: 'spectre', inputFiles: ['/tmp/x'] });
      } catch (err) {
        threw = true;
        assert(err instanceof Error && err.message.includes('500'), 'error mentions status code');
      }
      assert(threw, 'should throw on HTTP error');
    } finally {
      restoreFetch();
    }
  });

  await test('4e. VM Provider: jobStatus and cancelJob', async () => {
    mockFetch(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      if (body.method === 'engine_bay.job_status') {
        return jsonRpcResponse(body.id as number, {
          jobId: 'job-002', state: 'running', engine: 'spectre', progress: 50,
        });
      }
      if (body.method === 'engine_bay.cancel_job') {
        return jsonRpcResponse(body.id as number, { jobId: 'job-002', cancelled: true });
      }
      return new Response('Not found', { status: 404 });
    });

    try {
      const provider = new VMExecutionProvider();
      const status = await provider.jobStatus('job-002');
      assertEqual(status.state, 'running', 'job state');
      assertEqual(status.progress, 50, 'job progress');

      const cancel = await provider.cancelJob('job-002');
      assertEqual(cancel.cancelled, true, 'cancelled');
    } finally {
      restoreFetch();
    }
  });

  // ── Test 5: Full Pipeline (mock) ─────────────────────────────────────────

  await test('5. Full Pipeline: analyze_binary intent -> VM execution -> result', async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];

    mockFetch(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      capturedRequests.push(body);
      const mockResult: AnalysisResult = {
        jobId: 'job-e2e-001',
        exitCode: 0,
        outputFiles: ['/tmp/out/analysis.json'],
        engineOutput: '{"functions": 42, "vulnerabilities": 3}',
        engineErrors: '',
        durationMs: 5678,
      };
      return jsonRpcResponse(body.id as number, mockResult);
    });

    try {
      // Step 1: Map intent to engine request
      const mapper = new IntentMapper();
      const mapped = mapper.map('analyze_binary', { path: '/tmp/target.ipa' });

      assertEqual(mapped.requests.length, 1, 'single request mapped');
      assertEqual(mapped.requests[0].engine, 'spectre', 'engine is spectre');

      // Step 2: Execute through VM provider
      const provider = new VMExecutionProvider({ runtimeUrl: 'http://test-runtime:8400' });
      const result = await provider.executeEngine(mapped.requests[0]);

      // Step 3: Verify the chain
      assertEqual(capturedRequests.length, 1, 'one RPC call made');
      const rpcParams = capturedRequests[0].params as Record<string, unknown>;
      assertEqual(rpcParams.engine, 'spectre', 'RPC engine param');
      assertDeepEqual(rpcParams.input_files, ['/tmp/target.ipa'], 'RPC input_files');
      assertEqual(rpcParams.enable_cortex, true, 'Cortex enabled for spectre');

      // Step 4: Verify result format matches expected schema
      assertEqual(typeof result.jobId, 'string', 'result.jobId is string');
      assertEqual(typeof result.exitCode, 'number', 'result.exitCode is number');
      assert(Array.isArray(result.outputFiles), 'result.outputFiles is array');
      assertEqual(typeof result.engineOutput, 'string', 'result.engineOutput is string');
      assertEqual(typeof result.durationMs, 'number', 'result.durationMs is number');

      // Step 5: Verify result contents
      assertEqual(result.jobId, 'job-e2e-001', 'jobId');
      assertEqual(result.exitCode, 0, 'exitCode');
      assertEqual(result.durationMs, 5678, 'durationMs');
    } finally {
      restoreFetch();
    }
  });

  await test('5b. Full Pipeline: multi-engine full_analysis -> multiple VM executions', async () => {
    const capturedMethods: string[] = [];
    const capturedEngines: string[] = [];
    let callCount = 0;

    mockFetch(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      capturedMethods.push(body.method as string);
      const params = body.params as Record<string, unknown>;
      capturedEngines.push(params.engine as string);
      callCount++;

      const mockResult: AnalysisResult = {
        jobId: `job-multi-${callCount}`,
        exitCode: 0,
        outputFiles: [`/tmp/out/result-${callCount}.json`],
        engineOutput: `Engine ${params.engine} done`,
        engineErrors: '',
        durationMs: 1000 * callCount,
      };
      return jsonRpcResponse(body.id as number, mockResult);
    });

    try {
      // Map multi-engine intent
      const mapper = new IntentMapper();
      const mapped = mapper.map('full_analysis', { path: '/tmp/app.ipa', url: 'https://example.com' });

      assertEqual(mapped.requests.length, 3, '3 engine requests');

      // Execute all through VM provider
      const provider = new VMExecutionProvider({ runtimeUrl: 'http://test-runtime:8400' });

      // Separate parallel from sequential based on mapped.parallel flags
      const parallelRequests = mapped.requests.filter((_, i) => mapped.parallel[i]);
      const sequentialRequests = mapped.requests.filter((_, i) => !mapped.parallel[i]);

      // Execute parallel requests concurrently
      const parallelResults = await Promise.all(
        parallelRequests.map(req => provider.executeEngine(req))
      );

      // Execute sequential requests in order
      const sequentialResults: AnalysisResult[] = [];
      for (const req of sequentialRequests) {
        sequentialResults.push(await provider.executeEngine(req));
      }

      const allResults = [...parallelResults, ...sequentialResults];

      // Verify all engines were called
      assertEqual(capturedEngines.length, 3, 'three RPC calls');
      assert(capturedEngines.includes('spectre'), 'spectre called');
      assert(capturedEngines.includes('crawlio'), 'crawlio called');
      assert(capturedEngines.includes('interceptor'), 'interceptor called');

      // Verify all used engine_bay.execute
      for (const m of capturedMethods) {
        assertEqual(m, 'engine_bay.execute', 'all use engine_bay.execute');
      }

      // Verify each result is valid
      for (const result of allResults) {
        assertEqual(typeof result.jobId, 'string', 'result jobId is string');
        assertEqual(result.exitCode, 0, 'result exitCode is 0');
      }
    } finally {
      restoreFetch();
    }
  });

  await test('5c. Full Pipeline: MCP response format for vm_execute_engine', async () => {
    mockFetch(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonRpcResponse(body.id as number, {
        jobId: 'job-format-001',
        exitCode: 0,
        outputFiles: ['/tmp/out/report.json'],
        engineOutput: '{"result": "ok"}',
        engineErrors: '',
        durationMs: 100,
      });
    });

    try {
      const provider = new VMExecutionProvider();
      const result = await provider.executeEngine({
        engine: 'spectre',
        inputFiles: ['/tmp/test.ipa'],
      });

      // Simulate MCP response formatting (as done in index.ts handleVmExecuteEngine)
      const mcpResponse = {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };

      assertEqual(mcpResponse.content.length, 1, 'one content block');
      assertEqual(mcpResponse.content[0].type, 'text', 'content type is text');

      const parsed = JSON.parse(mcpResponse.content[0].text);
      assertEqual(parsed.jobId, 'job-format-001', 'parsed jobId');
      assertEqual(parsed.exitCode, 0, 'parsed exitCode');
    } finally {
      restoreFetch();
    }
  });

  // ─── Results ─────────────────────────────────────────────────────────────

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
