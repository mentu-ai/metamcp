import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    console.log(`  FAIL: ${name} - ${msg}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => rejectPort(new Error('failed to allocate port')));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function startServer(token?: string): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'metamcp-http-'));
  const config = join(dir, 'mcp.json');
  await writeFile(config, '{"mcpServers":{}}\n');

  const port = await freePort();
  const child = spawn(process.execPath, [
    'dist/index.js',
    '--transport', 'http',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--config', config,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      METAMCP_HTTP_BEARER_TOKEN: token ?? '',
    },
  });

  const stderr: string[] = [];
  child.stderr.on('data', chunk => stderr.push(String(chunk)));

  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url, child, stderr);

  return {
    url,
    stop: async () => {
      await stopProcess(child);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function waitForHealth(
  url: string,
  child: ChildProcessWithoutNullStreams,
  stderr: string[],
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early: ${stderr.join('')}`);
    }
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become healthy: ${stderr.join('')}`);
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 1000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function mcpPost(url: string, id: number, method: string, headers: Record<string, string> = {}) {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: method === 'initialize' ? {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'metamcp-http-test', version: '0.0.1' },
    } : {} }),
  });
}

async function runTests(): Promise<void> {
  console.log('HTTP Transport Tests\n');

  await test('health, initialize, and tools/list work without gateway token', async () => {
    const server = await startServer();
    try {
      const health = await fetch(`${server.url}/healthz`);
      assert(health.status === 200, `health status ${health.status}`);
      const healthBody = await health.json() as { ok?: boolean; transport?: string };
      assert(healthBody.ok === true, 'health ok');
      assert(healthBody.transport === 'http', 'health transport');

      const init = await mcpPost(server.url, 1, 'initialize');
      assert(init.status === 200, `initialize status ${init.status}`);
      const initBody = await init.json() as { result?: { serverInfo?: { name?: string } } };
      assert(initBody.result?.serverInfo?.name === 'metamcp', 'initialize server name');

      const list = await mcpPost(server.url, 2, 'tools/list');
      assert(list.status === 200, `tools/list status ${list.status}`);
      const listBody = await list.json() as { result?: { tools?: Array<{ name: string }> } };
      assert(listBody.result?.tools?.length === 6, 'six public tools');
    } finally {
      await server.stop();
    }
  });

  await test('gateway token rejects missing auth and accepts Authorization bearer', async () => {
    const server = await startServer('secret-token');
    try {
      const denied = await mcpPost(server.url, 1, 'tools/list');
      assert(denied.status === 401, `missing token status ${denied.status}`);

      const allowed = await mcpPost(server.url, 2, 'tools/list', {
        authorization: 'Bearer secret-token',
      });
      assert(allowed.status === 200, `bearer token status ${allowed.status}`);
    } finally {
      await server.stop();
    }
  });

  await test('gateway token accepts X-MetaMCP-Token for Cloud Run identity split', async () => {
    const server = await startServer('secret-token');
    try {
      const allowed = await mcpPost(server.url, 1, 'tools/list', {
        'x-metamcp-token': 'secret-token',
      });
      assert(allowed.status === 200, `x-metamcp-token status ${allowed.status}`);
    } finally {
      await server.stop();
    }
  });

  if (failed > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
