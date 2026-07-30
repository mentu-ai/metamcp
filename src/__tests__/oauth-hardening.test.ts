/**
 * OAuth Hardening Tests (MCP 2026-07-28 authorization)
 *
 * Hand-rolled runner (same pattern as sandbox.test.ts).
 * Import from .js extensions, run from dist/.
 *
 * Test groups:
 * 1. CSRF state — generation, constant-time compare, mismatch rejection
 * 2. RFC 9207 issuer validation
 * 3. Loopback callback server — ephemeral port, capture, validation, errors
 * 4. Step-up authorization — insufficient_scope handling
 */

import {
  parseScopes,
  computeScopeUnion,
  isScopeSuperset,
  isInsufficientScope,
  stepUpScope,
  generateState,
  secureEquals,
  assertIssuer,
  validateCallback,
  LoopbackCallbackServer,
  OAuthCallbackError,
} from '../oauth-hardening.js';

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

function assertThrows(fn: () => void, match: string, label: string): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes(match)) throw new Error(`${label}: expected error containing "${match}", got "${msg}"`);
    return;
  }
  throw new Error(`${label}: expected a throw, got none`);
}

/** GET a URL and discard the body — drives the callback listener. */
async function hit(url: string): Promise<void> {
  await fetch(url).then((r) => r.text());
}

// ─── 1. CSRF State ───────────────────────────────────────────────────────────

console.log('CSRF State\n');

await test('generateState produces unique, high-entropy values', () => {
  const a = generateState();
  const b = generateState();
  assert(a !== b, 'two states collided');
  assert(a.length >= 43, `state too short for 256 bits: ${a.length} chars`);
});

await test('generateState is URL-safe', () => {
  assert(/^[A-Za-z0-9_-]+$/.test(generateState()), 'state contains characters needing URL escaping');
});

await test('secureEquals matches identical strings and rejects others', () => {
  const s = generateState();
  assertEqual(secureEquals(s, s), true, 'identical');
  assertEqual(secureEquals(s, generateState()), false, 'different values');
  assertEqual(secureEquals('abc', 'abcd'), false, 'different lengths');
  assertEqual(secureEquals('', ''), true, 'empty strings');
});

await test('missing state in the response is rejected', () => {
  assertThrows(
    () => validateCallback({ code: 'c', state: null, iss: null }, { expectedState: 'expected' }),
    'missing the state parameter',
    'null state'
  );
});

await test('mismatched state is rejected as CSRF', () => {
  assertThrows(
    () => validateCallback({ code: 'c', state: 'attacker', iss: null }, { expectedState: 'ours' }),
    'state mismatch',
    'wrong state'
  );
});

await test('matching state passes', () => {
  const s = generateState();
  validateCallback({ code: 'c', state: s, iss: null }, { expectedState: s });
});

// ─── 2. RFC 9207 Issuer Validation ───────────────────────────────────────────

console.log('\nRFC 9207 Issuer Validation\n');

await test('matching issuer passes', () => {
  assertIssuer('https://auth.example.com', 'https://auth.example.com');
});

await test('mismatched issuer is rejected', () => {
  assertThrows(
    () => assertIssuer('https://evil.example.com', 'https://auth.example.com'),
    'issuer mismatch',
    'wrong issuer'
  );
});

await test('issuer comparison is exact, not URL-normalised', () => {
  // RFC 8414 issuers must be byte-identical; a trailing slash is a different issuer.
  assertThrows(
    () => assertIssuer('https://auth.example.com/', 'https://auth.example.com'),
    'issuer mismatch',
    'trailing slash'
  );
});

await test('absent iss is allowed (server does not implement RFC 9207)', () => {
  assertIssuer(null, 'https://auth.example.com');
});

await test('unpinned issuer is allowed (first authorization)', () => {
  assertIssuer('https://auth.example.com', undefined);
});

await test('issuer is still checked when state is absent from expectations', () => {
  assertThrows(
    () => validateCallback({ code: 'c', state: null, iss: 'https://evil.example.com' }, { expectedIssuer: 'https://good.example.com' }),
    'issuer mismatch',
    'issuer checked independently'
  );
});

// ─── 3. Loopback Callback Server ─────────────────────────────────────────────

console.log('\nLoopback Callback Server\n');

await test('binds an OS-assigned port, not a fixed one', async () => {
  const a = await LoopbackCallbackServer.start();
  const b = await LoopbackCallbackServer.start();
  try {
    assert(a.port > 0 && b.port > 0, 'ports assigned');
    assert(a.port !== b.port, 'two concurrent flows got distinct ports');
    // The old implementation pinned 19890, allowing exactly one flow per machine.
    assert(a.port !== 19890 || b.port !== 19890, 'ports are not the legacy fixed port');
  } finally {
    a.close();
    b.close();
  }
});

await test('redirectUrl names the bound loopback port', async () => {
  const s = await LoopbackCallbackServer.start();
  try {
    assertEqual(s.redirectUrl, `http://127.0.0.1:${s.port}/callback`, 'redirectUrl');
  } finally {
    s.close();
  }
});

await test('captures a code and returns it when state matches', async () => {
  const s = await LoopbackCallbackServer.start();
  const state = generateState();
  const wait = s.waitForCode({ expectedState: state });
  await hit(`${s.redirectUrl}?code=abc123&state=${state}`);
  const { code } = await wait;
  assertEqual(code, 'abc123', 'code');
});

await test('rejects a callback whose state does not match', async () => {
  const s = await LoopbackCallbackServer.start();
  const wait = s.waitForCode({ expectedState: generateState() }).then(() => null, (e: unknown) => e);
  await hit(`${s.redirectUrl}?code=abc123&state=${generateState()}`);
  const err = await wait;
  assert(err instanceof OAuthCallbackError, `expected a typed rejection, got ${String(err)}`);
  assert(String(err).includes('state mismatch'), `unexpected message: ${String(err)}`);
});

await test('rejects a callback from the wrong issuer', async () => {
  const s = await LoopbackCallbackServer.start();
  const state = generateState();
  const wait = s
    .waitForCode({ expectedState: state, expectedIssuer: 'https://good.example.com' })
    .then(() => null, (e: unknown) => e);
  await hit(`${s.redirectUrl}?code=abc123&state=${state}&iss=${encodeURIComponent('https://evil.example.com')}`);
  const err = await wait;
  assert(err instanceof OAuthCallbackError, `expected a typed rejection, got ${String(err)}`);
  assert(String(err).includes('issuer mismatch'), `unexpected message: ${String(err)}`);
});

await test('surfaces the observed issuer so it can be pinned', async () => {
  const s = await LoopbackCallbackServer.start();
  const state = generateState();
  const wait = s.waitForCode({ expectedState: state });
  await hit(`${s.redirectUrl}?code=abc123&state=${state}&iss=${encodeURIComponent('https://auth.example.com')}`);
  const { iss } = await wait;
  assertEqual(iss, 'https://auth.example.com', 'observed issuer returned');
});

await test('an error response rejects with the server-supplied reason', async () => {
  const s = await LoopbackCallbackServer.start();
  const wait = s.waitForCode({}).then(() => null, (e: unknown) => e);
  await hit(`${s.redirectUrl}?error=access_denied`);
  const err = await wait;
  assert(err instanceof OAuthCallbackError, `expected a typed rejection, got ${String(err)}`);
  assert(String(err).includes('access_denied'), `unexpected message: ${String(err)}`);
});

await test('the listener is closed once the flow resolves', async () => {
  const s = await LoopbackCallbackServer.start();
  const port = s.port;
  const state = generateState();
  const wait = s.waitForCode({ expectedState: state });
  await hit(`${s.redirectUrl}?code=abc&state=${state}`);
  await wait;
  // A fresh listener may now take the port back, proving the old one released it.
  await new Promise((r) => setTimeout(r, 50));
  let reachable = true;
  try {
    await fetch(`http://127.0.0.1:${port}/callback?code=x`);
  } catch {
    reachable = false;
  }
  assertEqual(reachable, false, 'listener still accepting connections after completion');
});

await test('times out when no callback ever arrives', async () => {
  const s = await LoopbackCallbackServer.start();
  let threw = false;
  try {
    await s.waitForCode({ timeoutMs: 100 });
  } catch (err) {
    threw = true;
    assert(String(err).includes('timed out'), `unexpected message: ${String(err)}`);
  }
  assert(threw, 'expected a timeout');
});

// ─── 4. Step-up Authorization ────────────────────────────────────────────────

console.log('\nStep-up Authorization\n');

await test('parseScopes splits on any whitespace and drops blanks', () => {
  assertEqual(parseScopes('read  write\tadmin').join(','), 'read,write,admin', 'split');
  assertEqual(parseScopes(undefined).length, 0, 'undefined');
  assertEqual(parseScopes('   ').length, 0, 'blank');
});

await test('computeScopeUnion is additive and order-stable', () => {
  assertEqual(computeScopeUnion('read', 'write'), 'read write', 'union');
  assertEqual(computeScopeUnion('read write', 'write'), 'read write', 'no duplicates');
  assertEqual(computeScopeUnion(undefined, 'write'), 'write', 'from empty');
  assertEqual(computeScopeUnion('read', undefined), 'read', 'nothing required');
});

await test('step-up never drops an already-granted scope', () => {
  // Re-authorizing with only the demanded scope would lose `read`, and the next
  // call needing it would step up again — an authorization loop.
  const widened = stepUpScope('read', { error: 'insufficient_scope', scope: 'write' });
  assert(widened !== null && widened.includes('read'), `lost the held scope: ${widened}`);
  assert(widened !== null && widened.includes('write'), `missing the demanded scope: ${widened}`);
});

await test('isScopeSuperset reports coverage', () => {
  assertEqual(isScopeSuperset('read write', 'read'), true, 'covered');
  assertEqual(isScopeSuperset('read', 'read write'), false, 'not covered');
  assertEqual(isScopeSuperset(undefined, undefined), true, 'both empty');
});

await test('isInsufficientScope only matches the step-up challenge', () => {
  assertEqual(isInsufficientScope({ error: 'insufficient_scope' }), true, 'step-up');
  assertEqual(isInsufficientScope({ error: 'invalid_token' }), false, 'expired token');
  assertEqual(isInsufficientScope(undefined), false, 'no challenge');
});

await test('no step-up for a non-scope challenge', () => {
  // An expired token is re-authorized normally; widening scope would not help.
  assertEqual(stepUpScope('read', { error: 'invalid_token', scope: 'write' }), null, 'invalid_token');
});

await test('no step-up when the demanded scope is already held', () => {
  // Otherwise the client would re-authorize forever against a server that keeps
  // rejecting for some other reason.
  assertEqual(stepUpScope('read write', { error: 'insufficient_scope', scope: 'read' }), null, 'already held');
});

await test('no step-up when the challenge names no scope', () => {
  assertEqual(stepUpScope('read', { error: 'insufficient_scope' }), null, 'nothing to widen to');
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
