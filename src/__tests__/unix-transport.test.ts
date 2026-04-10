/**
 * Unix Transport Tests — UnixJsonRpcTransport + UnixHttpTransport
 *
 * All tests are mocked (no real daemon needed). Follows the hand-rolled test
 * runner pattern from sandbox.test.ts.
 */

import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Socket } from 'node:net';

// ── Test Runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  FAIL: ${message}`);
  }
}

// ── Mock Socket (for NDJSON transport) ───────────────────────────────────────

class MockSocket extends EventEmitter {
  public written: string[] = [];
  public ended = false;
  public destroyed = false;
  public encoding = '';

  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  end(): void { this.ended = true; }
  destroy(): void { this.destroyed = true; }
  setEncoding(enc: string): void { this.encoding = enc; }
}

// ── Testable UnixJsonRpcTransport ────────────────────────────────────────────
// Subclass to bypass real socket creation and expose buffer processing.

import { UnixJsonRpcTransport } from '../unix-jsonrpc-transport.js';

class TestableJsonRpcTransport extends UnixJsonRpcTransport {
  public mockSocket: MockSocket;

  constructor() {
    super('/tmp/test.sock');
    this.mockSocket = new MockSocket();
  }

  /** Skip real socket creation — inject mock and mark as connected. */
  async start(): Promise<void> {
    // Access private fields via bracket notation
    (this as any).socket = this.mockSocket;
    (this as any).connected = true;

    // Wire up data events to processReadBuffer
    this.mockSocket.on('data', (chunk: string) => {
      (this as any).buffer += chunk;
      (this as any).processReadBuffer();
    });
  }

  /** Expose the socket's written data for assertions. */
  get writtenData(): string[] {
    return this.mockSocket.written;
  }
}

// ── Testable UnixHttpTransport ───────────────────────────────────────────────
// Subclass to bypass real HTTP and socket checks.

import { UnixHttpTransport } from '../unix-http-transport.js';

/** Tracks the last HTTP request made by the transport. */
let lastDispatchMethod = '';
let lastDispatchPath = '';
let lastDispatchBody: Record<string, unknown> | undefined;
let httpMockStatus = 200;
let httpMockData: unknown = { ok: true };

class TestableHttpTransport extends UnixHttpTransport {
  constructor() {
    super('/tmp/mentud.sock');
  }

  /** Skip the /ready probe and mark as alive. */
  async start(): Promise<void> {
    (this as any).alive = true;
    // Override private httpReq via bracket notation
    (this as any).httpReq = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => {
      lastDispatchMethod = method;
      lastDispatchPath = path;
      lastDispatchBody = body;
      return Promise.resolve({ status: httpMockStatus, data: httpMockData });
    };
  }
}

// Verify we can actually override httpReq — it's private. If it fails we'll
// use a different approach. Let's check at runtime.

// ── Tests ────────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {

  // ── Group 1: UnixJsonRpcTransport — NDJSON buffer parsing ──────────────

  console.log('\n── Group 1: UnixJsonRpcTransport — NDJSON buffer parsing ──');

  // 1. Single complete message
  {
    const transport = new TestableJsonRpcTransport();
    const messages: JSONRPCMessage[] = [];
    await transport.start();
    transport.onmessage = (msg) => messages.push(msg);
    transport.mockSocket.emit('data', '{"jsonrpc":"2.0","id":1,"result":"ok"}\n');
    assert(messages.length === 1, 'single complete message dispatched');
    assert((messages[0] as any).id === 1, 'message id preserved');
    await transport.close();
  }

  // 2. Multiple messages in one chunk
  {
    const transport = new TestableJsonRpcTransport();
    const messages: JSONRPCMessage[] = [];
    await transport.start();
    transport.onmessage = (msg) => messages.push(msg);
    transport.mockSocket.emit('data', '{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":2}\n');
    assert(messages.length === 2, 'two messages from one chunk');
    assert((messages[0] as any).id === 1 && (messages[1] as any).id === 2, 'both message ids correct');
    await transport.close();
  }

  // 3. Partial message across chunks
  {
    const transport = new TestableJsonRpcTransport();
    const messages: JSONRPCMessage[] = [];
    await transport.start();
    transport.onmessage = (msg) => messages.push(msg);
    transport.mockSocket.emit('data', '{"jsonrpc":"2.');
    assert(messages.length === 0, 'partial message not dispatched yet');
    transport.mockSocket.emit('data', '0","id":3}\n');
    assert(messages.length === 1, 'complete message dispatched after second chunk');
    assert((messages[0] as any).id === 3, 'reassembled message id correct');
    await transport.close();
  }

  // 4. Empty lines ignored
  {
    const transport = new TestableJsonRpcTransport();
    const messages: JSONRPCMessage[] = [];
    await transport.start();
    transport.onmessage = (msg) => messages.push(msg);
    transport.mockSocket.emit('data', '\n  \n{"jsonrpc":"2.0","id":4}\n\n');
    assert(messages.length === 1, 'empty lines ignored, only real message dispatched');
    await transport.close();
  }

  // 5. Malformed JSON triggers onerror
  {
    const transport = new TestableJsonRpcTransport();
    const errors: Error[] = [];
    await transport.start();
    // Must set onmessage so optional chaining evaluates JSON.parse (which throws)
    transport.onmessage = () => {};
    transport.onerror = (err) => errors.push(err);
    transport.mockSocket.emit('data', 'not-json\n');
    assert(errors.length === 1, `malformed JSON triggers onerror (got ${errors.length})`);
    assert(errors.length > 0 && errors[0].message.includes('Invalid JSON'), 'error message mentions invalid JSON');
    await transport.close();
  }

  // ── Group 2: UnixJsonRpcTransport — send() ────────────────────────────

  console.log('\n── Group 2: UnixJsonRpcTransport — send() ──');

  // 1. Produces valid NDJSON
  {
    const transport = new TestableJsonRpcTransport();
    await transport.start();
    const msg = { jsonrpc: '2.0' as const, method: 'test', id: 5 };
    await transport.send(msg as any);
    assert(transport.writtenData.length === 1, 'send() writes to socket');
    assert(transport.writtenData[0] === JSON.stringify(msg) + '\n', 'send() produces JSON + newline');
    await transport.close();
  }

  // 2. Throws if not started
  {
    // Use real constructor (not testable) to ensure connected=false
    const transport = new TestableJsonRpcTransport();
    // Don't call start() — connected is false by default in the real class
    // But our TestableJsonRpcTransport inherits from UnixJsonRpcTransport with connected=false initially
    // Actually, TestableJsonRpcTransport.start() sets connected=true, so we skip it.
    // We need to access without start. Create a raw UnixJsonRpcTransport but don't start.
    const rawTransport = new UnixJsonRpcTransport('/tmp/test.sock');
    let threw = false;
    try {
      await rawTransport.send({ jsonrpc: '2.0', method: 'test', id: 6 } as any);
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes('not started'), 'error message mentions not started');
    }
    assert(threw, 'send() before start() throws');
  }

  // ── Group 3: UnixHttpTransport — MCP message translation ──────────────

  console.log('\n── Group 3: UnixHttpTransport — MCP message translation ──');

  // 1. initialize → synthetic response
  {
    const transport = new TestableHttpTransport();
    const messages: any[] = [];
    await transport.start();
    transport.onmessage = (msg) => messages.push(msg);
    await transport.send({ jsonrpc: '2.0', method: 'initialize', id: 1 } as any);
    assert(messages.length === 1, 'initialize produces response');
    assert(messages[0].result.protocolVersion === '2024-11-05', 'initialize has protocolVersion');
    assert(messages[0].result.capabilities?.tools !== undefined, 'initialize has capabilities.tools');
    assert(messages[0].result.serverInfo?.name === 'mentud', 'initialize serverInfo.name is mentud');
    await transport.close();
  }

  // 2. tools/list → tool catalog
  {
    const transport = new TestableHttpTransport();
    const messages: any[] = [];
    await transport.start();
    transport.onmessage = (msg) => messages.push(msg);
    await transport.send({ jsonrpc: '2.0', method: 'tools/list', id: 2 } as any);
    assert(messages.length === 1, 'tools/list produces response');
    const tools = messages[0].result.tools;
    assert(Array.isArray(tools), 'tools/list result has tools array');
    assert(tools.length === 18, `tools/list returns 18 tools (got ${tools.length})`);
    const names = tools.map((t: any) => t.name);
    assert(names.includes('daemon_health'), 'tools include daemon_health');
    assert(names.includes('ane_status'), 'tools include ane_status');
    assert(names.includes('lifecycle_capture'), 'tools include lifecycle_capture');
    await transport.close();
  }

  // 3. tools/call → HTTP dispatch (daemon_health → GET /health)
  {
    httpMockStatus = 200;
    httpMockData = { status: 'ok' };
    const transport = new TestableHttpTransport();
    const messages: any[] = [];
    await transport.start();
    transport.onmessage = (msg) => messages.push(msg);
    await transport.send({
      jsonrpc: '2.0', method: 'tools/call', id: 3,
      params: { name: 'daemon_health', arguments: {} },
    } as any);
    assert(messages.length === 1, 'tools/call daemon_health produces response');
    assert(lastDispatchMethod === 'GET', 'daemon_health dispatches GET');
    assert(lastDispatchPath === '/health', 'daemon_health dispatches to /health');
    await transport.close();
  }

  // 4. tools/call → lifecycle POST
  {
    httpMockStatus = 200;
    httpMockData = { id: 'abc-123' };
    const transport = new TestableHttpTransport();
    const messages: any[] = [];
    await transport.start();
    transport.onmessage = (msg) => messages.push(msg);
    await transport.send({
      jsonrpc: '2.0', method: 'tools/call', id: 4,
      params: { name: 'lifecycle_capture', arguments: { content: 'test', source: 'agent' } },
    } as any);
    assert(messages.length === 1, 'tools/call lifecycle_capture produces response');
    assert(lastDispatchMethod === 'POST', 'lifecycle_capture dispatches POST');
    assert(lastDispatchPath === '/lifecycle/capture', 'lifecycle_capture dispatches to /lifecycle/capture');
    assert(lastDispatchBody?.content === 'test', 'lifecycle_capture sends body with content');
    await transport.close();
  }

  // 5. Unknown tool → error
  {
    const transport = new TestableHttpTransport();
    const messages: any[] = [];
    await transport.start();
    transport.onmessage = (msg) => messages.push(msg);
    await transport.send({
      jsonrpc: '2.0', method: 'tools/call', id: 5,
      params: { name: 'nonexistent_tool', arguments: {} },
    } as any);
    assert(messages.length === 1, 'unknown tool produces response');
    assert(messages[0].error !== undefined, 'unknown tool returns JSON-RPC error');
    assert(messages[0].error.message.includes('Unknown tool'), 'error mentions unknown tool');
    await transport.close();
  }

  // 6. notifications/initialized → no-op
  {
    const transport = new TestableHttpTransport();
    const messages: any[] = [];
    await transport.start();
    transport.onmessage = (msg) => messages.push(msg);
    // Notification: has method but no id
    await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as any);
    assert(messages.length === 0, 'notification does not trigger onmessage');
    await transport.close();
  }

  // ── Group 4: Config integration ───────────────────────────────────────

  console.log('\n── Group 4: Config integration ──');

  const { loadConfig } = await import('../config.js');

  const tmpDir = '/tmp/mentu-test-' + Date.now();
  const tmpConfig = tmpDir + '/.mcp.json';
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(tmpConfig, JSON.stringify({
    mcpServers: {
      'mentud-http': {
        type: 'unix-http',
        socketPath: '~/.mentu/mentu.sock',
      },
      'mentud-jsonrpc': {
        type: 'unix-jsonrpc',
        socketPath: '/var/run/mentu.sock',
      },
    },
  }));

  const configs = loadConfig(tmpConfig);

  const httpConf = configs.find((c: any) => c.name === 'mentud-http');
  const jsonrpcConf = configs.find((c: any) => c.name === 'mentud-jsonrpc');

  // 1. unix-http transport parsed
  assert(httpConf !== undefined, 'unix-http config entry exists');
  assert(httpConf!.transport === 'unix-http', 'unix-http transport field correct');
  assert(httpConf!.socketPath === '~/.mentu/mentu.sock', 'unix-http socketPath preserved');

  // 2. unix-jsonrpc transport parsed
  assert(jsonrpcConf !== undefined, 'unix-jsonrpc config entry exists');
  assert(jsonrpcConf!.transport === 'unix-jsonrpc', 'unix-jsonrpc transport field correct');

  // 3. socketPath resolved (tilde expansion happens in transport constructor)
  {
    const t = new UnixJsonRpcTransport('~/.mentu/test.sock');
    // The resolved path is private — verify via the "not found" error which contains the resolved path
    let errMsg = '';
    try { await t.start(); } catch (e) { errMsg = (e as Error).message; }
    assert(!errMsg.includes('~'), 'tilde in socketPath is resolved to homedir');
    assert(errMsg.includes(homedir()), 'resolved path contains homedir');
  }

  // Cleanup
  unlinkSync(tmpConfig);
  rmdirSync(tmpDir);

  // ── Group 5: McpClient transport selection ────────────────────────────

  console.log('\n── Group 5: McpClient transport selection ──');

  const { McpClient } = await import('../mcp-client.js');

  // 1. unix-http config → isRemote true
  {
    const client = new McpClient({
      name: 'test-http',
      command: '',
      criticality: 'optional' as const,
      transport: 'unix-http' as const,
      socketPath: '/tmp/test.sock',
    });
    assert(client.isRemote === true, 'unix-http transport is remote');
  }

  // 2. unix-jsonrpc config → isRemote true
  {
    const client = new McpClient({
      name: 'test-jsonrpc',
      command: '',
      criticality: 'optional' as const,
      transport: 'unix-jsonrpc' as const,
      socketPath: '/tmp/test.sock',
    });
    assert(client.isRemote === true, 'unix-jsonrpc transport is remote');
  }

  // 3. Missing socketPath → falls through to stdio
  {
    const client = new McpClient({
      name: 'test-fallback',
      command: 'echo',
      criticality: 'optional' as const,
      transport: 'unix-http' as const,
      // No socketPath
    });
    assert(client.config.transport === 'unix-http', 'transport field is unix-http');
    assert(client.config.socketPath === undefined, 'socketPath is undefined — would fall through to stdio');
  }

  // ── Results ────────────────────────────────────────────────────────────

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
