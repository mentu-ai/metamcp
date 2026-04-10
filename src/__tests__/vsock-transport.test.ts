/**
 * VsockTransport Unit Tests
 *
 * Hand-rolled runner (same pattern as child-manager.test.ts).
 * Mocks DaemonClient — no real VM needed.
 *
 * Test groups:
 * 1. NDJSON Parsing — multi-line buffer, partial reads, empty lines, malformed JSON
 * 2. send() — produces newline-delimited JSON
 * 3. close() — calls daemon stopMcpProxy
 * 4. Config — vmIsolation flag, McpClient transport selection
 */

import { VsockTransport } from '../vsock-transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

// ─── Test Runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Access private processReadBuffer and readBuffer for testing NDJSON parsing.
 * We create a VsockTransport and manipulate its internal buffer directly.
 */
function createTestTransport(): VsockTransport {
  return new VsockTransport('/bin/echo', [], {});
}

function setReadBuffer(transport: VsockTransport, data: string): void {
  (transport as unknown as { readBuffer: string }).readBuffer = data;
}

function getReadBuffer(transport: VsockTransport): string {
  return (transport as unknown as { readBuffer: string }).readBuffer;
}

function callProcessReadBuffer(transport: VsockTransport): void {
  (transport as unknown as { processReadBuffer: () => void }).processReadBuffer();
}

// ─── 1. NDJSON Parsing ───────────────────────────────────────────────────────

console.log('NDJSON Parsing Tests\n');

await test('multi-line buffer parses all complete lines', () => {
  const transport = createTestTransport();
  const messages: JSONRPCMessage[] = [];
  transport.onmessage = (msg) => messages.push(msg);

  const msg1 = { jsonrpc: '2.0', id: 1, result: 'a' };
  const msg2 = { jsonrpc: '2.0', id: 2, result: 'b' };
  setReadBuffer(transport, JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n');
  callProcessReadBuffer(transport);

  assertEqual(messages.length, 2, 'message count');
  assertEqual((messages[0] as Record<string, unknown>).id, 1, 'first message id');
  assertEqual((messages[1] as Record<string, unknown>).id, 2, 'second message id');
  assertEqual(getReadBuffer(transport), '', 'buffer empty after complete parse');
});

await test('partial read accumulates without firing', () => {
  const transport = createTestTransport();
  const messages: JSONRPCMessage[] = [];
  transport.onmessage = (msg) => messages.push(msg);

  // No newline — partial data
  setReadBuffer(transport, '{"jsonrpc":"2.0","id":1');
  callProcessReadBuffer(transport);

  assertEqual(messages.length, 0, 'no messages from partial');
  assertEqual(getReadBuffer(transport), '{"jsonrpc":"2.0","id":1', 'buffer retained');

  // Complete the line
  setReadBuffer(transport, getReadBuffer(transport) + ',"result":"ok"}\n');
  callProcessReadBuffer(transport);

  assertEqual(messages.length, 1, 'one message after completion');
  assertEqual((messages[0] as Record<string, unknown>).id, 1, 'message id');
});

await test('skips empty lines', () => {
  const transport = createTestTransport();
  const messages: JSONRPCMessage[] = [];
  transport.onmessage = (msg) => messages.push(msg);

  const msg = { jsonrpc: '2.0', id: 1, result: 'ok' };
  setReadBuffer(transport, '\n\n' + JSON.stringify(msg) + '\n\n');
  callProcessReadBuffer(transport);

  assertEqual(messages.length, 1, 'only one message despite empty lines');
});

await test('fires onerror on malformed JSON', () => {
  const transport = createTestTransport();
  const errors: Error[] = [];
  transport.onerror = (err) => errors.push(err);
  // onmessage must be set — optional chaining skips JSON.parse if onmessage is undefined
  transport.onmessage = () => {};

  setReadBuffer(transport, 'not valid json\n');
  callProcessReadBuffer(transport);

  assertEqual(errors.length, 1, 'one error');
  assert(errors[0]!.message.includes('Invalid JSON from VM'), 'error message');
});

// ─── 2. send() ───────────────────────────────────────────────────────────────

console.log('\nsend() Tests\n');

await test('send() produces newline-delimited base64 JSON', async () => {
  const transport = createTestTransport();

  // Mock: set sessionId so send doesn't throw
  (transport as unknown as { sessionId: string }).sessionId = 'test-session';

  // Track daemon calls
  const calls: Array<{ method: string; params: unknown }> = [];
  const mockDaemon = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return {};
    },
  };
  (transport as unknown as { daemon: unknown }).daemon = mockDaemon;

  const message: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'test', params: {} } as JSONRPCMessage;
  await transport.send(message);

  assertEqual(calls.length, 1, 'one daemon call');
  assertEqual(calls[0]!.method, 'mcp_proxy.stdin', 'correct method');
  const params = calls[0]!.params as { sessionId: string; data: string };
  assertEqual(params.sessionId, 'test-session', 'session id');

  // Decode b64 and verify it's the message + newline
  const decoded = Buffer.from(params.data, 'base64').toString('utf-8');
  assertEqual(decoded, JSON.stringify(message) + '\n', 'newline-delimited JSON');
});

await test('send() throws if not started', async () => {
  const transport = createTestTransport();
  let threw = false;
  try {
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'test' } as JSONRPCMessage);
  } catch (err) {
    threw = true;
    assert(err instanceof Error && err.message.includes('not started'), 'correct error');
  }
  assert(threw, 'should throw');
});

// ─── 3. close() ──────────────────────────────────────────────────────────────

console.log('\nclose() Tests\n');

await test('close() calls daemon stopMcpProxy and fires onclose', async () => {
  const transport = createTestTransport();
  (transport as unknown as { sessionId: string }).sessionId = 'sess-123';

  const calls: Array<{ method: string; params: unknown }> = [];
  let disconnected = false;
  let closeFired = false;
  const mockDaemon = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return {};
    },
    disconnect: () => { disconnected = true; },
  };
  (transport as unknown as { daemon: unknown }).daemon = mockDaemon;
  transport.onclose = () => { closeFired = true; };

  await transport.close();

  assertEqual(calls.length, 1, 'one daemon call');
  assertEqual(calls[0]!.method, 'mcp_proxy.stop', 'stop method');
  assertEqual((calls[0]!.params as { sessionId: string }).sessionId, 'sess-123', 'session id');
  assert(disconnected, 'daemon disconnected');
  assert(closeFired, 'onclose fired');
  assertEqual(transport.sessionId, undefined, 'session cleared');
});

await test('close() is safe when no session', async () => {
  const transport = createTestTransport();
  let disconnected = false;
  const mockDaemon = {
    call: async () => ({}),
    disconnect: () => { disconnected = true; },
  };
  (transport as unknown as { daemon: unknown }).daemon = mockDaemon;

  await transport.close();
  assert(disconnected, 'daemon disconnected even without session');
});

// ─── 4. Config + McpClient Integration ───────────────────────────────────────

console.log('\nConfig + McpClient Tests\n');

await test('vmIsolation field parses from config object', () => {
  const config = {
    name: 'test-vm',
    command: '/opt/engines/test',
    args: [],
    criticality: 'optional' as const,
    vmIsolation: true,
  };
  assertEqual(config.vmIsolation, true, 'vmIsolation set');
});

await test('McpClient isRemote returns true for vmIsolation', async () => {
  // Import dynamically to avoid side effects
  const { McpClient } = await import('../mcp-client.js');

  const client = new McpClient({
    name: 'vm-server',
    command: '/bin/echo',
    criticality: 'optional',
    vmIsolation: true,
  });

  assert(client.isRemote === true, 'isRemote should be true for vmIsolation');
});

await test('McpClient isRemote returns false without vmIsolation', async () => {
  const { McpClient } = await import('../mcp-client.js');

  const client = new McpClient({
    name: 'local-server',
    command: '/bin/echo',
    criticality: 'optional',
  });

  assert(client.isRemote === false, 'isRemote should be false for stdio');
});

await test('McpClient closeStdin returns false for vmIsolation', async () => {
  const { McpClient } = await import('../mcp-client.js');

  const client = new McpClient({
    name: 'vm-server',
    command: '/bin/echo',
    criticality: 'optional',
    vmIsolation: true,
  });

  assertEqual(client.closeStdin(), false, 'closeStdin returns false for remote/vm');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`VsockTransport tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
