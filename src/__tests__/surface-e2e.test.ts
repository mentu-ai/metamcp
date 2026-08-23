import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`  FAIL: ${name} - ${message}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  console.log('MetaMCP Surface E2E Tests\n');

  await test('three-tool surface stays lazy and runs a real child Method end to end', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metamcp-surface-'));
    const methodsDir = join(root, 'methods');
    const cacheDir = join(root, 'cache');
    const marker = join(root, 'child-started.txt');
    const listMarker = join(root, 'child-listed.txt');
    const mutationMarker = join(root, 'mutation.txt');
    mkdirSync(methodsDir, { recursive: true });

    const fixturePath = resolve('dist', '__tests__', 'fixtures', 'echo-server.js');
    const gatewayPath = resolve('dist', 'index.js');
    const configPath = join(root, 'mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixturePath],
          env: {
            METAMCP_FIXTURE_START_MARKER: marker,
            METAMCP_FIXTURE_LIST_MARKER: listMarker,
            METAMCP_FIXTURE_MUTATION_MARKER: mutationMarker,
          },
        },
      },
    }, null, 2));
    writeFileSync(join(methodsDir, 'fixture.upper.json'), JSON.stringify({
      apiVersion: 'metamcp.io/v1alpha1',
      kind: 'Method',
      metadata: {
        name: 'fixture.upper',
        version: '1.0.0',
        description: 'Acquire and normalize fixture text',
      },
      spec: {
        effects: 'read',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
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
        output: { value: '${steps.normalize.structuredContent.value}' },
      },
    }, null, 2));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [gatewayPath, '--config', configPath, '--methods', methodsDir],
      cwd: root,
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        METAMCP_CACHE_DIR: cacheDir,
      },
    });
    const stderr: string[] = [];
    transport.stderr?.on('data', chunk => stderr.push(String(chunk)));
    const client = new Client({ name: 'metamcp-e2e', version: '1.0.0' });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert(
        JSON.stringify(listed.tools.map(tool => tool.name)) === JSON.stringify(['mcp_discover', 'mcp_call', 'mcp_run']),
        `unexpected tool surface: ${listed.tools.map(tool => tool.name).join(', ')}`,
      );

      const discovered = await client.callTool({ name: 'mcp_discover', arguments: {} });
      assert(discovered.isError !== true, 'discover failed');
      assert(!existsSync(marker), 'plain discovery spawned the child');
      const discovery = discovered.structuredContent as {
        servers?: Array<{ name: string; state: string }>;
        methods?: Array<{ name: string }>;
      };
      assert(discovery.servers?.[0]?.state === 'configured', 'server should remain configured-only');
      assert(discovery.methods?.[0]?.name === 'fixture.upper', 'method should be discoverable statically');

      const [called, concurrent] = await Promise.all([
        client.callTool({
          name: 'mcp_call',
          arguments: { server: 'fixture', tool: 'echo', args: { value: 'direct' } },
        }),
        client.callTool({
          name: 'mcp_call',
          arguments: { server: 'fixture', tool: 'echo', args: { value: 'concurrent' } },
        }),
      ]);
      assert(called.isError !== true && concurrent.isError !== true, 'concurrent direct calls failed');
      assert(existsSync(marker), 'target child did not start lazily');
      assert(readFileSync(marker, 'utf-8').trim().split('\n').length === 1, 'concurrent calls spawned duplicate children');

      const methodResult = await client.callTool({
        name: 'mcp_run',
        arguments: { method: 'fixture.upper', input: { value: 'evidence' } },
      });
      assert(methodResult.isError !== true, `method failed: ${JSON.stringify(methodResult)}`);
      const runResult = methodResult.structuredContent as {
        status?: string;
        output?: { value?: string };
        trace?: unknown[];
      };
      assert(runResult.status === 'completed', 'method completion status');
      assert(runResult.output?.value === 'EVIDENCE', 'method normalized output');
      assert(runResult.trace?.length === 2, 'method trace length');

      const refreshed = await client.callTool({
        name: 'mcp_discover',
        arguments: { server: 'fixture', refresh: true },
      });
      assert(refreshed.isError !== true, 'targeted schema refresh failed');
      assert(readFileSync(listMarker, 'utf-8').trim().split('\n').length === 2, 'refresh did not re-read live schemas');
      assert(readFileSync(marker, 'utf-8').trim().split('\n').length === 1, 'refresh spawned a replacement child');

      const removed = await client.callTool({ name: 'mcp_execute', arguments: { code: 'return process' } });
      assert(removed.isError === true, 'removed arbitrary-code tool unexpectedly executed');

      const applicationError = await client.callTool({
        name: 'mcp_call',
        arguments: { server: 'fixture', tool: 'fail', args: {} },
      });
      assert(applicationError.isError === true, 'child application error was not preserved');
      assert(readFileSync(marker, 'utf-8').trim().split('\n').length === 1, 'application error retired a healthy child');
      const ledgerPath = join(root, '.metamcp', 'ledger.jsonl');
      const ledger = readFileSync(ledgerPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line) as {
        childTool?: string;
        success?: boolean;
      });
      const failureEntry = ledger.slice().reverse().find(entry => entry.childTool === 'fail');
      assert(failureEntry?.success === false, 'ledger recorded a child application error as success');

      const originalPid = Number(readFileSync(marker, 'utf-8').trim());
      const timedOut = await client.callTool({
        name: 'mcp_call',
        arguments: { server: 'fixture', tool: 'hang', args: {}, timeoutMs: 75 },
      });
      assert(timedOut.isError === true, 'hung child call should time out');
      let originalStillAlive = true;
      try {
        process.kill(originalPid, 0);
      } catch {
        originalStillAlive = false;
      }
      assert(!originalStillAlive, 'timed-out child process was not reaped');

      const afterTimeout = await client.callTool({
        name: 'mcp_call',
        arguments: { server: 'fixture', tool: 'echo', args: { value: 'explicit-restart' } },
      });
      assert(afterTimeout.isError !== true, 'explicit call did not restart the retired child');
      assert(readFileSync(marker, 'utf-8').trim().split('\n').length === 2, 'explicit call did not create exactly one replacement child');

      const uncertainWrite = await client.callTool({
        name: 'mcp_call',
        arguments: { server: 'fixture', tool: 'mutate_then_exit', args: {} },
      });
      assert(uncertainWrite.isError === true, 'crashed mutation should report an error');
      assert(readFileSync(mutationMarker, 'utf-8').trim().split('\n').length === 1, 'uncertain mutation was replayed');
      assert(readFileSync(marker, 'utf-8').trim().split('\n').length === 2, 'transport failure spawned an implicit retry child');
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}\nGateway stderr:\n${stderr.join('')}`);
    } finally {
      await client.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  await test('recursive MetaMCP child configurations fail before serving tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metamcp-recursive-'));
    const gatewayPath = resolve('dist', 'index.js');
    const configPath = join(root, 'mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        recursive: { command: process.execPath, args: [gatewayPath, '--config', configPath] },
      },
    }));
    const child = spawn(process.execPath, [gatewayPath, '--config', configPath], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        METAMCP_CACHE_DIR: join(root, 'cache'),
      },
    });
    const stderr: string[] = [];
    child.stderr.on('data', chunk => stderr.push(String(chunk)));
    try {
      const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
        const timer = setTimeout(() => rejectExit(new Error('recursive gateway did not exit')), 3000);
        child.once('exit', code => {
          clearTimeout(timer);
          resolveExit(code);
        });
      });
      assert(exitCode !== 0, `recursive gateway exited ${exitCode}`);
      assert(stderr.join('').includes('Refusing recursive MetaMCP'), `missing recursive refusal: ${stderr.join('')}`);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });

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
