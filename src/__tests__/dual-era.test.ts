/**
 * Dual-Era Server Surface Tests (MCP 2026-07-28)
 *
 * Hand-rolled test runner.
 * Import from .js extensions, run from dist/.
 *
 * Test groups:
 * 1. Era classification — initialize vs server/discover vs _meta-bearing
 * 2. Modern _meta validation — required fields and new error codes
 * 3. server/discover — result shape
 * 4. Result decoration — resultType, serverInfo, list cache hints
 * 5. Transport wiring — legacy passthrough, modern interception, decoration
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  classifyEra,
  validateModernMeta,
  buildDiscoverResult,
  decorateModernResult,
  DualEraServerTransport,
  isModernProtocolVersion,
  FIRST_MODERN_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  SERVER_INFO_META_KEY,
  ProtocolErrorCode,
  type DualEraOptions,
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OPTS: DualEraOptions = {
  serverInfo: { name: 'test-server', version: '9.9.9' },
  capabilities: { tools: { listChanged: true } },
};

/** A well-formed modern request. */
function modernRequest(method: string, id: number | string = 1): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: FIRST_MODERN_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  } as unknown as JSONRPCMessage;
}

/** Records everything written to the wire, and lets us inject inbound traffic. */
class FakeInnerTransport implements Transport {
  sent: JSONRPCMessage[] = [];
  started = false;
  closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {
    this.started = true;
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  /** Simulate a client sending us a message. */
  receive(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }
}

async function wired(opts: DualEraOptions = OPTS): Promise<{
  inner: FakeInnerTransport;
  outer: DualEraServerTransport;
  forwarded: JSONRPCMessage[];
}> {
  const inner = new FakeInnerTransport();
  const outer = new DualEraServerTransport(inner, opts);
  const forwarded: JSONRPCMessage[] = [];
  outer.onmessage = (m) => forwarded.push(m);
  await outer.start();
  return { inner, outer, forwarded };
}

// ─── 1. Era Classification ───────────────────────────────────────────────────

console.log('Era Classification\n');

await test('initialize is legacy', () => {
  assertEqual(
    classifyEra({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } as JSONRPCMessage),
    'legacy',
    'initialize'
  );
});

await test('initialize stays legacy even when it carries modern _meta', () => {
  // The spec makes `initialize` the legacy-era selector; _meta must not override it.
  assertEqual(classifyEra(modernRequest('initialize')), 'legacy', 'initialize + _meta');
});

await test('server/discover is modern', () => {
  assertEqual(
    classifyEra({ jsonrpc: '2.0', id: 1, method: 'server/discover' } as JSONRPCMessage),
    'modern',
    'server/discover'
  );
});

await test('request carrying _meta protocolVersion is modern', () => {
  assertEqual(classifyEra(modernRequest('tools/list')), 'modern', 'tools/list + _meta');
});

await test('bare tools/list with no _meta is legacy', () => {
  assertEqual(
    classifyEra({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage),
    'legacy',
    'bare tools/list'
  );
});

await test('notifications and responses are legacy (never intercepted)', () => {
  assertEqual(
    classifyEra({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage),
    'legacy',
    'notification'
  );
  assertEqual(classifyEra({ jsonrpc: '2.0', id: 1, result: {} } as JSONRPCMessage), 'legacy', 'response');
});

await test('isModernProtocolVersion orders revisions chronologically', () => {
  assertEqual(isModernProtocolVersion('2026-07-28'), true, 'first modern');
  assertEqual(isModernProtocolVersion('2027-01-01'), true, 'later revision');
  assertEqual(isModernProtocolVersion('2025-11-25'), false, 'legacy latest');
});

// ─── 2. Modern _meta Validation ──────────────────────────────────────────────

console.log('\nModern _meta Validation\n');

await test('well-formed modern request passes', () => {
  assertEqual(validateModernMeta(modernRequest('tools/list')), null, 'valid request');
});

await test('missing protocolVersion → -32602 InvalidParams', () => {
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: {} } } as JSONRPCMessage;
  assertEqual(validateModernMeta(msg)?.code, ProtocolErrorCode.InvalidParams, 'code');
});

await test('unsupported protocolVersion → -32022 with supported list', () => {
  const msg = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '1999-01-01', [CLIENT_CAPABILITIES_META_KEY]: {} } },
  } as unknown as JSONRPCMessage;
  const err = validateModernMeta(msg);
  assertEqual(err?.code, ProtocolErrorCode.UnsupportedProtocolVersion, 'code');
  assert(
    Array.isArray(err?.data?.supported) && (err?.data?.supported as string[]).includes(FIRST_MODERN_PROTOCOL_VERSION),
    'error data advertises the supported revisions'
  );
});

await test('missing clientCapabilities → -32602 InvalidParams', () => {
  const msg = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: { [PROTOCOL_VERSION_META_KEY]: FIRST_MODERN_PROTOCOL_VERSION } },
  } as unknown as JSONRPCMessage;
  assertEqual(validateModernMeta(msg)?.code, ProtocolErrorCode.InvalidParams, 'code');
});

await test('server/discover is exempt from version requirements', () => {
  // It is the call used to *learn* the versions, so it cannot require one.
  const msg = { jsonrpc: '2.0', id: 1, method: 'server/discover' } as JSONRPCMessage;
  assertEqual(validateModernMeta(msg), null, 'discover exempt');
});

// ─── 3. server/discover ──────────────────────────────────────────────────────

console.log('\nserver/discover\n');

await test('discover result has required supportedVersions + capabilities', () => {
  const r = buildDiscoverResult(OPTS);
  assert(Array.isArray(r.supportedVersions), 'supportedVersions is an array');
  assert((r.supportedVersions as string[]).includes(FIRST_MODERN_PROTOCOL_VERSION), 'advertises modern revision');
  assert(r.capabilities !== undefined, 'capabilities present');
});

await test('discover never advertises a legacy version', () => {
  const versions = buildDiscoverResult(OPTS).supportedVersions as string[];
  assert(versions.every(isModernProtocolVersion), `legacy version leaked into discover: ${versions.join(',')}`);
});

await test('discover carries serverInfo under the spec _meta key', () => {
  const meta = buildDiscoverResult(OPTS)._meta as Record<string, unknown>;
  assertEqual((meta[SERVER_INFO_META_KEY] as { name: string }).name, 'test-server', 'serverInfo.name');
});

await test('instructions are included only when provided', () => {
  assertEqual('instructions' in buildDiscoverResult(OPTS), false, 'omitted by default');
  assertEqual(buildDiscoverResult({ ...OPTS, instructions: 'hi' }).instructions, 'hi', 'included when set');
});

// ─── 4. Result Decoration ────────────────────────────────────────────────────

console.log('\nResult Decoration\n');

await test('every modern result gets resultType "complete"', () => {
  assertEqual(decorateModernResult({}, 'tools/call', OPTS).resultType, 'complete', 'resultType');
});

await test('every modern result carries serverInfo', () => {
  const meta = decorateModernResult({}, 'tools/call', OPTS)._meta as Record<string, unknown>;
  assertEqual((meta[SERVER_INFO_META_KEY] as { version: string }).version, '9.9.9', 'serverInfo.version');
});

await test('list results carry required ttlMs + cacheScope', () => {
  const r = decorateModernResult({ tools: [] }, 'tools/list', OPTS);
  assertEqual(typeof r.ttlMs, 'number', 'ttlMs present');
  assertEqual(r.cacheScope, 'private', 'defaults to private (per-installation catalog)');
});

await test('non-list results do not carry cache hints', () => {
  const r = decorateModernResult({ content: [] }, 'tools/call', OPTS);
  assertEqual('ttlMs' in r, false, 'no ttlMs on tools/call');
  assertEqual('cacheScope' in r, false, 'no cacheScope on tools/call');
});

await test('configured list cache overrides the default', () => {
  const r = decorateModernResult({}, 'tools/list', {
    ...OPTS,
    listCache: { ttlMs: 30_000, cacheScope: 'public' },
  });
  assertEqual(r.ttlMs, 30_000, 'ttlMs');
  assertEqual(r.cacheScope, 'public', 'cacheScope');
});

await test('decoration preserves the payload and pre-existing _meta', () => {
  const r = decorateModernResult({ tools: ['a'], _meta: { keep: 1 } }, 'tools/list', OPTS);
  assertEqual((r.tools as string[])[0], 'a', 'payload preserved');
  assertEqual((r._meta as Record<string, unknown>).keep, 1, 'existing _meta preserved');
});

// ─── 5. Transport Wiring ─────────────────────────────────────────────────────

console.log('\nTransport Wiring\n');

await test('legacy traffic is forwarded to the inner Server untouched', async () => {
  const { inner, forwarded } = await wired();
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } as JSONRPCMessage;
  inner.receive(init);
  assertEqual(forwarded.length, 1, 'forwarded to Server');
  assertEqual(forwarded[0], init, 'same object, unmodified');
  assertEqual(inner.sent.length, 0, 'nothing answered at the transport');
});

await test('server/discover is answered without reaching the Server', async () => {
  const { inner, forwarded } = await wired();
  inner.receive({ jsonrpc: '2.0', id: 7, method: 'server/discover' } as JSONRPCMessage);
  assertEqual(forwarded.length, 0, 'Server never sees it');
  assertEqual(inner.sent.length, 1, 'answered directly');
  const res = inner.sent[0] as unknown as { id: number; result: Record<string, unknown> };
  assertEqual(res.id, 7, 'id echoed');
  assert(Array.isArray(res.result.supportedVersions), 'discover payload');
});

await test('invalid modern request is rejected without reaching the Server', async () => {
  const { inner, forwarded } = await wired();
  inner.receive({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: 'nope' } } } as unknown as JSONRPCMessage);
  assertEqual(forwarded.length, 0, 'Server never sees an invalid request');
  const err = (inner.sent[0] as unknown as { error: { code: number } }).error;
  assertEqual(err.code, ProtocolErrorCode.UnsupportedProtocolVersion, 'error code');
});

await test('valid modern request reaches the Server and its result is decorated', async () => {
  const { inner, outer, forwarded } = await wired();
  inner.receive(modernRequest('tools/list', 42));
  assertEqual(forwarded.length, 1, 'forwarded to existing handlers');

  // The Server replies through the outer transport, as it would in production.
  await outer.send({ jsonrpc: '2.0', id: 42, result: { tools: [] } } as unknown as JSONRPCMessage);
  const out = inner.sent[0] as unknown as { result: Record<string, unknown> };
  assertEqual(out.result.resultType, 'complete', 'resultType stamped');
  assertEqual(typeof out.result.ttlMs, 'number', 'list cache hints stamped');
  assert((out.result._meta as Record<string, unknown>)[SERVER_INFO_META_KEY] !== undefined, 'serverInfo stamped');
});

await test('legacy responses are never decorated', async () => {
  const { inner, outer } = await wired();
  inner.receive({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} } as JSONRPCMessage);
  await outer.send({ jsonrpc: '2.0', id: 5, result: { tools: [] } } as unknown as JSONRPCMessage);
  const out = inner.sent[0] as unknown as { result: Record<string, unknown> };
  assertEqual('resultType' in out.result, false, 'legacy result untouched');
  assertEqual('ttlMs' in out.result, false, 'no cache hints on legacy result');
});

await test('error responses to modern requests keep JSON-RPC error shape', async () => {
  const { inner, outer } = await wired();
  inner.receive(modernRequest('tools/call', 9));
  await outer.send({ jsonrpc: '2.0', id: 9, error: { code: -32603, message: 'boom' } } as unknown as JSONRPCMessage);
  const out = inner.sent[0] as unknown as { error?: { code: number }; result?: unknown };
  assertEqual(out.error?.code, -32603, 'error passed through');
  assertEqual(out.result, undefined, 'no result envelope added to an error');
});

await test('in-flight tracking does not leak across requests', async () => {
  const { inner, outer } = await wired();
  inner.receive(modernRequest('tools/list', 1));
  await outer.send({ jsonrpc: '2.0', id: 1, result: { tools: [] } } as unknown as JSONRPCMessage);
  // A later, unrelated response reusing the same id must not be decorated.
  await outer.send({ jsonrpc: '2.0', id: 1, result: { tools: [] } } as unknown as JSONRPCMessage);
  const second = inner.sent[1] as unknown as { result: Record<string, unknown> };
  assertEqual('resultType' in second.result, false, 'id no longer tracked after responding');
});

await test('start/close propagate to the inner transport', async () => {
  const { inner, outer } = await wired();
  assertEqual(inner.started, true, 'inner started');
  await outer.close();
  assertEqual(inner.closed, true, 'inner closed');
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
