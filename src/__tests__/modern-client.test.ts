/**
 * Modern-Era Outbound Tests (client side of MCP 2026-07-28)
 *
 * Hand-rolled test runner.
 * Import from .js extensions, run from dist/.
 *
 * Test groups:
 * 1. PreStartedTransport — idempotent start, buffered handover
 * 2. Era probe — modern, legacy, and failure verdicts
 * 3. ModernMcpSession — _meta on every request, envelope unwrapping, errors
 * 4. Round-trip against the dual-era server surface
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  PreStartedTransport,
  probeChildEra,
  ModernMcpSession,
  ModernRequestError,
  InputRequiredError,
  unwrapTransport,
} from '../modern-client.js';
import {
  DualEraServerTransport,
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  FIRST_MODERN_PROTOCOL_VERSION,
} from '../dual-era.js';

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

const CLIENT_INFO = { name: 'metamcp-test', version: '1.0.0' };

// ─── Fake child transports ───────────────────────────────────────────────────

type Responder = (message: Record<string, unknown>) => Record<string, unknown> | null;

/**
 * A transport whose "server" is a function. `respond` returns the JSON-RPC
 * message to send back, or null to stay silent.
 */
class ScriptedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sent: Record<string, unknown>[] = [];
  starts = 0;
  closed = false;

  constructor(private readonly respond: Responder) {}

  async start(): Promise<void> {
    this.starts++;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const asRecord = message as unknown as Record<string, unknown>;
    this.sent.push(asRecord);
    const reply = this.respond(asRecord);
    if (reply) {
      // Deliver asynchronously, as a real transport would.
      setTimeout(() => this.onmessage?.(reply as unknown as JSONRPCMessage), 0);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Push an unsolicited message (notification) at the client. */
  emit(message: Record<string, unknown>): void {
    this.onmessage?.(message as unknown as JSONRPCMessage);
  }
}

/** A modern child: answers server/discover, tools/list and tools/call. */
function modernChild(overrides: { discover?: Record<string, unknown> } = {}): ScriptedTransport {
  return new ScriptedTransport((msg) => {
    const id = msg.id;
    if (msg.method === 'server/discover') {
      return {
        jsonrpc: '2.0',
        id,
        result: overrides.discover ?? {
          supportedVersions: [FIRST_MODERN_PROTOCOL_VERSION],
          capabilities: { tools: { listChanged: true } },
        },
      };
    }
    if (msg.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private',
          tools: [{ name: 'echo', description: 'echoes', inputSchema: { type: 'object' } }],
        },
      };
    }
    if (msg.method === 'tools/call') {
      return { jsonrpc: '2.0', id, result: { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  });
}

/** A legacy child: MethodNotFound for server/discover, handshake otherwise. */
function legacyChild(): ScriptedTransport {
  return new ScriptedTransport((msg) => {
    const id = msg.id;
    if (msg.method === 'server/discover') {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
    }
    if (msg.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'legacy-child', version: '1.0.0' },
        },
      };
    }
    return { jsonrpc: '2.0', id, result: {} };
  });
}

// ─── 1. PreStartedTransport ──────────────────────────────────────────────────

console.log('PreStartedTransport\n');

await test('start is idempotent, so the SDK can re-start a live transport', async () => {
  // Protocol.connect() calls start(); the stdio transport throws on a second
  // start, and the era probe has necessarily started it already.
  const inner = legacyChild();
  const wrapper = new PreStartedTransport(inner);
  await wrapper.start();
  await wrapper.start();
  await wrapper.start();
  assertEqual(inner.starts, 1, 'inner started exactly once');
});

await test('messages arriving before a handler is attached are buffered, not dropped', async () => {
  const inner = legacyChild();
  const wrapper = new PreStartedTransport(inner);
  await wrapper.start();
  inner.emit({ jsonrpc: '2.0', method: 'notifications/message', params: { a: 1 } });
  inner.emit({ jsonrpc: '2.0', method: 'notifications/message', params: { a: 2 } });

  const seen: unknown[] = [];
  wrapper.onmessage = (m) => seen.push(m);
  assertEqual(seen.length, 2, 'both buffered messages replayed on attach');
});

await test('messages after attach go straight through', async () => {
  const inner = legacyChild();
  const wrapper = new PreStartedTransport(inner);
  const seen: unknown[] = [];
  wrapper.onmessage = (m) => seen.push(m);
  inner.emit({ jsonrpc: '2.0', method: 'notifications/message', params: {} });
  assertEqual(seen.length, 1, 'delivered');
});

await test('close and send delegate to the inner transport', async () => {
  const inner = legacyChild();
  const wrapper = new PreStartedTransport(inner);
  await wrapper.send({ jsonrpc: '2.0', id: 1, method: 'ping' } as unknown as JSONRPCMessage);
  assertEqual(inner.sent.length, 1, 'send delegated');
  await wrapper.close();
  assertEqual(inner.closed, true, 'close delegated');
});

await test('lifecycle lookups see through the wrapper', async () => {
  // Child shutdown reads `pid` and the stdio transport's private `_process` off
  // whatever transport object it holds. Once that object is the wrapper, a
  // non-forwarding wrapper would silently downgrade every graceful shutdown to
  // a signal kill.
  class WithLifecycle extends ScriptedTransport {
    pid = 4242;
    _process = { stdin: {} };
    stderr = 'stream';
  }
  const inner = new WithLifecycle(() => null);
  const wrapper = new PreStartedTransport(inner);
  assertEqual((wrapper as unknown as { pid: number }).pid, 4242, 'pid forwarded');
  assert((wrapper as unknown as { _process?: unknown })._process !== undefined, '_process forwarded');
  assertEqual((wrapper as unknown as { stderr: string }).stderr, 'stream', 'stderr forwarded');
  assertEqual(unwrapTransport(wrapper), inner, 'unwrapTransport returns the inner transport');
  assertEqual(unwrapTransport(inner), inner, 'unwrapping a plain transport is a no-op');
});

// ─── 2. Era Probe ────────────────────────────────────────────────────────────

console.log('\nEra Probe\n');

await test('a child advertising 2026-07-28 probes as modern', async () => {
  const t = new PreStartedTransport(modernChild());
  await t.start();
  const probe = await probeChildEra(t);
  assertEqual(probe.era, 'modern', 'era');
  assertEqual(probe.supportedVersions?.[0], FIRST_MODERN_PROTOCOL_VERSION, 'versions');
  assert(probe.capabilities !== undefined, 'capabilities captured');
});

await test('the probe asks server/discover and sends no initialize', async () => {
  // An initialize would commit the connection to the legacy era per spec.
  const inner = modernChild();
  const t = new PreStartedTransport(inner);
  await t.start();
  await probeChildEra(t);
  assertEqual(inner.sent.length, 1, 'exactly one request');
  assertEqual(inner.sent[0].method, 'server/discover', 'method');
});

await test('MethodNotFound probes as legacy', async () => {
  const t = new PreStartedTransport(legacyChild());
  await t.start();
  assertEqual((await probeChildEra(t)).era, 'legacy', 'era');
});

await test('a child advertising only legacy revisions probes as legacy', async () => {
  const t = new PreStartedTransport(modernChild({ discover: { supportedVersions: ['2025-11-25'] } }));
  await t.start();
  const probe = await probeChildEra(t);
  assertEqual(probe.era, 'legacy', 'era');
  assert(probe.reason?.includes('no modern revision') === true, `reason: ${probe.reason}`);
});

await test('a silent child falls back to legacy instead of hanging forever', async () => {
  // A probe failure must never make a reachable child unreachable.
  const silent = new ScriptedTransport(() => null);
  const t = new PreStartedTransport(silent);
  await t.start();
  const probe = await probeChildEra(t, { timeoutMs: 80 });
  assertEqual(probe.era, 'legacy', 'era');
  assert(probe.reason?.includes('Timed out') === true, `reason: ${probe.reason}`);
});

await test('a garbage discover result falls back to legacy', async () => {
  const t = new PreStartedTransport(modernChild({ discover: { supportedVersions: 'nope' } }));
  await t.start();
  assertEqual((await probeChildEra(t)).era, 'legacy', 'era');
});

// ─── 3. ModernMcpSession ─────────────────────────────────────────────────────

console.log('\nModernMcpSession\n');

await test('every request carries the required _meta fields', async () => {
  const inner = modernChild();
  const t = new PreStartedTransport(inner);
  await t.start();
  const session = new ModernMcpSession(t, { clientInfo: CLIENT_INFO });
  await session.listTools();

  const params = inner.sent[0].params as Record<string, unknown>;
  const meta = params._meta as Record<string, unknown>;
  assertEqual(meta[PROTOCOL_VERSION_META_KEY], FIRST_MODERN_PROTOCOL_VERSION, 'protocolVersion');
  assert(meta[CLIENT_CAPABILITIES_META_KEY] !== undefined, 'clientCapabilities present (required)');
  assertEqual((meta[CLIENT_INFO_META_KEY] as { name: string }).name, 'metamcp-test', 'clientInfo');
});

await test('no initialize is ever sent on a modern session', async () => {
  const inner = modernChild();
  const t = new PreStartedTransport(inner);
  await t.start();
  const session = new ModernMcpSession(t, { clientInfo: CLIENT_INFO });
  await session.listTools();
  await session.callTool('echo', { text: 'hi' });
  assert(
    inner.sent.every((m) => m.method !== 'initialize'),
    `sent an initialize: ${inner.sent.map((m) => m.method).join(',')}`
  );
});

await test('listTools unwraps the modern envelope', async () => {
  const t = new PreStartedTransport(modernChild());
  await t.start();
  const tools = await new ModernMcpSession(t, { clientInfo: CLIENT_INFO }).listTools();
  assertEqual(tools.length, 1, 'count');
  assertEqual(tools[0].name, 'echo', 'name');
  assertEqual(tools[0].description, 'echoes', 'description');
});

await test('callTool passes name and arguments', async () => {
  const inner = modernChild();
  const t = new PreStartedTransport(inner);
  await t.start();
  await new ModernMcpSession(t, { clientInfo: CLIENT_INFO }).callTool('echo', { text: 'hi' });
  const params = inner.sent[0].params as Record<string, unknown>;
  assertEqual(params.name, 'echo', 'name');
  assertEqual((params.arguments as { text: string }).text, 'hi', 'arguments');
});

await test('a JSON-RPC error surfaces with its code', async () => {
  const t = new PreStartedTransport(modernChild());
  await t.start();
  const session = new ModernMcpSession(t, { clientInfo: CLIENT_INFO });
  let caught: unknown;
  try {
    await session.request('nonexistent/method');
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof ModernRequestError, `expected ModernRequestError, got ${String(caught)}`);
  assertEqual((caught as ModernRequestError).code, -32601, 'code');
});

await test('input_required is raised, not returned as a completed result', async () => {
  // Returning it would let a caller treat a half-finished round-trip as done.
  const child = new ScriptedTransport((msg) => ({
    jsonrpc: '2.0',
    id: msg.id,
    result: { resultType: 'input_required', elicitation: { message: 'need a value' } },
  }));
  const t = new PreStartedTransport(child);
  await t.start();
  const session = new ModernMcpSession(t, { clientInfo: CLIENT_INFO });
  let caught: unknown;
  try {
    await session.callTool('needs-input');
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof InputRequiredError, `expected InputRequiredError, got ${String(caught)}`);
  assertEqual((caught as InputRequiredError).method, 'tools/call', 'method carried');
  assert((caught as InputRequiredError).result.elicitation !== undefined, 'payload carried for a caller that can answer');
});

await test('a request that never gets an answer times out', async () => {
  const t = new PreStartedTransport(new ScriptedTransport(() => null));
  await t.start();
  const session = new ModernMcpSession(t, { clientInfo: CLIENT_INFO, requestTimeoutMs: 80 });
  let msg = '';
  try {
    await session.listTools();
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  assert(msg.includes('Timed out'), `unexpected message: ${msg}`);
});

await test('concurrent requests are correlated by id, not order', async () => {
  // Replies deliberately arrive out of order.
  const child = new ScriptedTransport(() => null);
  const t = new PreStartedTransport(child);
  await t.start();
  const session = new ModernMcpSession(t, { clientInfo: CLIENT_INFO, requestTimeoutMs: 2000 });

  const first = session.request('a');
  const second = session.request('b');
  await new Promise((r) => setTimeout(r, 10));
  const ids = child.sent.map((m) => m.id);
  child.emit({ jsonrpc: '2.0', id: ids[1], result: { resultType: 'complete', which: 'second' } });
  child.emit({ jsonrpc: '2.0', id: ids[0], result: { resultType: 'complete', which: 'first' } });

  assertEqual((await first).which, 'first', 'first request got its own reply');
  assertEqual((await second).which, 'second', 'second request got its own reply');
});

await test('closing a session fails its in-flight requests', async () => {
  const t = new PreStartedTransport(new ScriptedTransport(() => null));
  await t.start();
  const session = new ModernMcpSession(t, { clientInfo: CLIENT_INFO, requestTimeoutMs: 5000 });
  const inflight = session.request('slow').then(() => null, (e: unknown) => e);
  await session.close();
  const err = await inflight;
  assert(err instanceof Error, `expected a rejection, got ${String(err)}`);
});

await test('an unexpected transport close fails in-flight requests immediately', async () => {
  const inner = new ScriptedTransport(() => null);
  const t = new PreStartedTransport(inner);
  await t.start();
  const session = new ModernMcpSession(t, { clientInfo: CLIENT_INFO, requestTimeoutMs: 5000 });
  const startedAt = Date.now();
  const inflight = session.request('slow').then(() => null, (e: unknown) => e);
  inner.onclose?.();
  const err = await inflight;
  assert(err instanceof Error && err.message.includes('Transport closed'), `unexpected rejection: ${String(err)}`);
  assert(Date.now() - startedAt < 500, 'transport close waited for the request timeout');
});

// ─── 4. Round-trip Against Our Own Server Surface ────────────────────────────

console.log('\nRound-trip Against dual-era Server\n');

/** Wires a client transport directly to a DualEraServerTransport. */
function loopback(): { client: Transport; serverInbound: (m: JSONRPCMessage) => void } {
  let clientOnMessage: ((m: JSONRPCMessage) => void) | undefined;
  let serverSend: ((m: JSONRPCMessage) => void) | undefined;

  const serverSide: Transport = {
    async start() {},
    async send(message) {
      clientOnMessage?.(message);
    },
    async close() {},
  };

  const outer = new DualEraServerTransport(serverSide, {
    serverInfo: { name: 'loopback-server', version: '9.9.9' },
    capabilities: { tools: { listChanged: true } },
  });

  const clientSide: Transport = {
    async start() {
      await outer.start();
    },
    async send(message) {
      serverSend?.(message);
    },
    async close() {
      await outer.close();
    },
    get onmessage() {
      return clientOnMessage;
    },
    set onmessage(h) {
      clientOnMessage = h;
    },
  } as Transport;

  // Inbound to the server goes through the dual-era wrapper's own handler.
  serverSend = (m) => (serverSide.onmessage as ((msg: JSONRPCMessage) => void) | undefined)?.(m);

  // The wrapper forwards non-modern traffic here; answer tools/list minimally.
  outer.onmessage = (message) => {
    const req = message as unknown as { id?: unknown; method?: string };
    if (req.method === 'tools/list') {
      void outer.send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'loop', inputSchema: {} }] } } as unknown as JSONRPCMessage);
    }
  };

  return { client: clientSide, serverInbound: (m) => serverSend?.(m) };
}

await test('our own dual-era server probes as modern from this client', async () => {
  const { client } = loopback();
  const t = new PreStartedTransport(client);
  await t.start();
  const probe = await probeChildEra(t);
  assertEqual(probe.era, 'modern', 'era');
  assertEqual(probe.supportedVersions?.[0], FIRST_MODERN_PROTOCOL_VERSION, 'version agreed by both halves');
});

await test('a modern tools/list round-trips through the real server surface', async () => {
  const { client } = loopback();
  const t = new PreStartedTransport(client);
  await t.start();
  const tools = await new ModernMcpSession(t, { clientInfo: CLIENT_INFO }).listTools();
  assertEqual(tools[0].name, 'loop', 'tool came back through the dual-era envelope');
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
