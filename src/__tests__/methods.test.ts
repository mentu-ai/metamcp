import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { MethodRegistry, MethodRunner } from '../methods.js';

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
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`  FAIL: ${name} - ${message}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function writeMethod(directory: string, name: string, value: unknown): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(value, null, 2));
}

function baseMethod(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 'metamcp.io/v1alpha1',
    kind: 'Method',
    metadata: { name: 'demo.pipeline', version: '1.0.0', description: 'Normalize a value' },
    spec: {
      effects: 'read',
      timeoutMs: 5000,
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      steps: [
        { id: 'acquire', server: 'fixture', tool: 'echo', args: { value: '${input.value}' } },
        {
          id: 'normalize',
          server: 'fixture',
          tool: 'upper',
          dependsOn: ['acquire'],
          args: { value: '${steps.acquire.structuredContent.value}' },
        },
      ],
      output: { answer: '${steps.normalize.structuredContent.value}' },
      ...overrides,
    },
  };
}

async function run(): Promise<void> {
  console.log('Method Mode Tests\n');

  const root = mkdtempSync(join(tmpdir(), 'metamcp-methods-'));
  try {
    await test('published schema accepts the published example', () => {
      const schema = JSON.parse(readFileSync(resolve('schemas', 'method-v1alpha1.schema.json'), 'utf-8')) as object;
      const example = JSON.parse(readFileSync(resolve('examples', 'methods', 'content.acquire-and-normalize.method.json'), 'utf-8')) as object;
      const validate = new Ajv2020({ allErrors: true }).compile(schema);
      assert(validate(example), `schema errors: ${JSON.stringify(validate.errors)}`);
    });

    await test('loads and searches declarative Method manifests', () => {
      const dir = join(root, 'catalog');
      writeMethod(dir, 'demo', baseMethod());
      const registry = new MethodRegistry(dir);
      assert(registry.reload() === 1, 'expected one method');
      assert(registry.list()[0]?.name === 'demo.pipeline', 'method name');
      assert(registry.search('normalize').length === 1, 'description search');
    });

    await test('runtime enforces the published manifest schema', () => {
      const dir = join(root, 'manifest-schema');
      writeMethod(dir, 'unknown-field', { ...baseMethod(), unexpected: true });
      let rejected = false;
      try {
        new MethodRegistry(dir).reload();
      } catch (err) {
        rejected = err instanceof Error && err.message.includes('additional properties');
      }
      assert(rejected, 'runtime accepted a manifest rejected by the published schema');
    });

    await test('runs a typed Acquire -> Normalize pipeline', async () => {
      const dir = join(root, 'pipeline');
      writeMethod(dir, 'demo', baseMethod());
      const registry = new MethodRegistry(dir);
      registry.reload();
      const calls: Array<{ tool: string; value: unknown }> = [];
      const runner = new MethodRunner(registry, async (_server, tool, args) => {
        calls.push({ tool, value: args?.value });
        const value = tool === 'upper' ? String(args?.value).toUpperCase() : args?.value;
        return { content: [], structuredContent: { value } };
      });
      const result = await runner.run('demo.pipeline', { value: 'evidence' });
      assert(result.status === 'completed', 'method status');
      assert((result.output as { answer?: string }).answer === 'EVIDENCE', 'normalized output');
      assert(calls.length === 2 && calls[1]?.value === 'evidence', 'step interpolation');
      assert(result.trace.length === 2 && result.gaps.length === 0, 'trace and gaps');
    });

    await test('converts an allowed step failure into a typed gap', async () => {
      const dir = join(root, 'gap');
      const method = baseMethod({
        outputSchema: {
          type: 'object',
          properties: { gapCode: { type: 'string' } },
          required: ['gapCode'],
        },
        steps: [{ id: 'capture', server: 'fixture', tool: 'fail', onError: 'gap' }],
        output: { gapCode: '${steps.capture.gap.code}' },
      });
      writeMethod(dir, 'gap', method);
      const registry = new MethodRegistry(dir);
      registry.reload();
      const runner = new MethodRunner(registry, async () => { throw new Error('secret child detail'); });
      const result = await runner.run('demo.pipeline', { value: 'x' });
      assert(result.status === 'completed_with_gaps', 'gap status');
      assert(result.gaps[0]?.code === 'step_failed', 'typed gap code');
      assert(!result.gaps[0]?.message.includes('secret'), 'raw child error not retained');
    });

    await test('allows bounded retry only when a step is declared safe', async () => {
      const dir = join(root, 'retry');
      writeMethod(dir, 'retry', baseMethod({
        steps: [{
          id: 'fetch',
          server: 'fixture',
          tool: 'read',
          idempotency: 'safe',
          retry: { maxAttempts: 2 },
          args: { value: '${input.value}' },
        }],
        output: { answer: '${steps.fetch.structuredContent.value}' },
      }));
      const registry = new MethodRegistry(dir);
      registry.reload();
      let attempts = 0;
      const runner = new MethodRunner(registry, async (_server, _tool, args) => {
        attempts++;
        if (attempts === 1) throw new Error('transient');
        return { structuredContent: { value: args?.value } };
      });
      await runner.run('demo.pipeline', { value: 'ok' });
      assert(attempts === 2, 'safe retry count');

      const unsafeDir = join(root, 'unsafe-retry');
      writeMethod(unsafeDir, 'unsafe', baseMethod({
        steps: [{ id: 'write', server: 'fixture', tool: 'mutate', retry: { maxAttempts: 2 } }],
      }));
      let rejected = false;
      try {
        new MethodRegistry(unsafeDir).reload();
      } catch (err) {
        rejected = err instanceof Error && err.message.includes('idempotency safe');
      }
      assert(rejected, 'unsafe retry manifest rejected');
    });

    await test('polls a safe status tool within explicit bounds', async () => {
      const dir = join(root, 'poll');
      writeMethod(dir, 'poll', baseMethod({
        steps: [{
          id: 'status',
          server: 'fixture',
          tool: 'status',
          idempotency: 'safe',
          poll: { path: 'structuredContent.state', equals: 'ready', maxAttempts: 3, intervalMs: 0 },
        }],
        output: { answer: '${steps.status.structuredContent.state}' },
      }));
      const registry = new MethodRegistry(dir);
      registry.reload();
      let calls = 0;
      const runner = new MethodRunner(registry, async () => {
        calls++;
        return { structuredContent: { state: calls < 3 ? 'pending' : 'ready' } };
      });
      const result = await runner.run('demo.pipeline', { value: 'x' });
      assert(calls === 3, 'poll call count');
      assert((result.output as { answer?: string }).answer === 'ready', 'poll output');
      assert(result.trace[0]?.attempts === 3, 'poll trace attempts');
    });

    await test('retry delays and output stay within Method bounds', async () => {
      const deadlineDir = join(root, 'deadline');
      writeMethod(deadlineDir, 'deadline', baseMethod({
        timeoutMs: 25,
        steps: [{
          id: 'read',
          server: 'fixture',
          tool: 'read',
          idempotency: 'safe',
          retry: { maxAttempts: 2, backoffMs: 1000 },
        }],
      }));
      const deadlineRegistry = new MethodRegistry(deadlineDir);
      deadlineRegistry.reload();
      const deadlineRunner = new MethodRunner(deadlineRegistry, async () => { throw new Error('offline'); });
      const startedAt = Date.now();
      let deadlineRejected = false;
      try {
        await deadlineRunner.run('demo.pipeline', { value: 'x' });
      } catch (err) {
        deadlineRejected = err instanceof Error && err.message.includes('deadline');
      }
      assert(deadlineRejected && Date.now() - startedAt < 500, 'retry backoff exceeded the overall deadline');

      const outputDir = join(root, 'output-limit');
      writeMethod(outputDir, 'output', baseMethod({
        maxOutputBytes: 8,
        outputSchema: undefined,
        steps: [{ id: 'read', server: 'fixture', tool: 'read' }],
        output: '${steps.read.structuredContent.value}',
      }));
      const outputRegistry = new MethodRegistry(outputDir);
      outputRegistry.reload();
      const outputRunner = new MethodRunner(outputRegistry, async () => ({ structuredContent: { value: 'far-too-large' } }));
      let outputRejected = false;
      try {
        await outputRunner.run('demo.pipeline', { value: 'x' });
      } catch (err) {
        outputRejected = err instanceof Error && err.message.includes('output exceeds');
      }
      assert(outputRejected, 'oversized output accepted');
    });

    await test('blocks write methods unless the gateway operator enables them', async () => {
      const dir = join(root, 'write-policy');
      writeMethod(dir, 'write', baseMethod({ effects: 'write' }));
      const registry = new MethodRegistry(dir);
      registry.reload();
      const runner = new MethodRunner(registry, async () => ({ structuredContent: { value: 'x' } }));
      let blocked = false;
      try {
        await runner.run('demo.pipeline', { value: 'x' });
      } catch (err) {
        blocked = err instanceof Error && err.message.includes('--allow-writes');
      }
      assert(blocked, 'write method blocked');
    });

    await test('rejects invalid inputs and unsafe template paths', async () => {
      const dir = join(root, 'validation');
      writeMethod(dir, 'demo', baseMethod({
        steps: [{ id: 'read', server: 'fixture', tool: 'read', args: { value: '${input.constructor}' } }],
      }));
      const registry = new MethodRegistry(dir);
      registry.reload();
      const runner = new MethodRunner(registry, async () => ({ structuredContent: { value: 'x' } }));
      let invalidInput = false;
      try {
        await runner.run('demo.pipeline', {});
      } catch (err) {
        invalidInput = err instanceof Error && err.message.includes('Invalid input');
      }
      assert(invalidInput, 'input schema enforced');

      let unsafeReference = false;
      try {
        await runner.run('demo.pipeline', { value: 'x' });
      } catch (err) {
        unsafeReference = err instanceof Error && err.message.includes('Unsafe method reference');
      }
      assert(unsafeReference, 'unsafe path blocked');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
