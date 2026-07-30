/**
 * Inbound Resource-Server Auth Tests (RFC 9728 / RFC 8707, MCP 2026-07-28)
 *
 * Hand-rolled runner (same pattern as sandbox.test.ts).
 * Import from .js extensions, run from dist/.
 *
 * Test groups:
 * 1. Protected Resource Metadata — well-known path, document, https guard
 * 2. WWW-Authenticate challenges
 * 3. Bearer header parsing
 * 4. Token claim validation — audience, issuer, expiry, scope
 */

import {
  protectedResourceMetadataPath,
  protectedResourceMetadataUrl,
  buildProtectedResourceMetadata,
  bearerChallenge,
  parseBearerToken,
  validateTokenClaims,
  authenticateBearer,
  InvalidTokenError,
  InsufficientScopeError,
  type AccessTokenClaims,
} from '../resource-auth.js';

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

const RESOURCE = 'https://mcp.example.com/gateway';
const ISSUER = 'https://auth.example.com';

function claims(over: Partial<AccessTokenClaims> = {}): AccessTokenClaims {
  return { iss: ISSUER, aud: RESOURCE, sub: 'user-1', scope: 'read write', ...over };
}

// ─── 1. Protected Resource Metadata ──────────────────────────────────────────

console.log('Protected Resource Metadata\n');

await test('a root resource gets the bare well-known path', () => {
  assertEqual(
    protectedResourceMetadataPath(new URL('https://mcp.example.com/')),
    '/.well-known/oauth-protected-resource',
    'root path'
  );
});

await test("a resource's own path is appended, so one host can serve several", () => {
  assertEqual(
    protectedResourceMetadataPath(new URL('https://mcp.example.com/gateway')),
    '/.well-known/oauth-protected-resource/gateway',
    'sub-path'
  );
});

await test('a trailing slash does not change the path', () => {
  assertEqual(
    protectedResourceMetadataPath(new URL('https://mcp.example.com/gateway/')),
    '/.well-known/oauth-protected-resource/gateway',
    'trailing slash'
  );
});

await test('the metadata URL is absolute', () => {
  assertEqual(
    protectedResourceMetadataUrl(new URL(RESOURCE)),
    'https://mcp.example.com/.well-known/oauth-protected-resource/gateway',
    'absolute url'
  );
});

await test('the document names the resource and its authorization server', () => {
  const doc = buildProtectedResourceMetadata({
    resourceUrl: new URL(RESOURCE),
    authorizationServers: [ISSUER],
    scopesSupported: ['read', 'write'],
    resourceName: 'MetaMCP Gateway',
  });
  assertEqual(doc.resource, RESOURCE, 'resource');
  assertEqual(doc.authorization_servers?.[0], ISSUER, 'authorization_servers');
  assertEqual(doc.scopes_supported?.join(','), 'read,write', 'scopes_supported');
  assertEqual(doc.resource_name, 'MetaMCP Gateway', 'resource_name');
});

await test('only header-borne tokens are advertised', () => {
  // Query-string tokens end up in access logs and Referer headers.
  const doc = buildProtectedResourceMetadata({
    resourceUrl: new URL(RESOURCE),
    authorizationServers: [ISSUER],
  });
  assertEqual(doc.bearer_methods_supported?.join(','), 'header', 'bearer_methods_supported');
});

await test('a plaintext resource URL is refused', () => {
  // This document tells clients where to send credentials.
  assertThrows(
    () =>
      buildProtectedResourceMetadata({
        resourceUrl: new URL('http://mcp.example.com/gateway'),
        authorizationServers: [ISSUER],
      }),
    'must use https',
    'http resource'
  );
});

await test('a plaintext authorization server is refused', () => {
  assertThrows(
    () =>
      buildProtectedResourceMetadata({
        resourceUrl: new URL(RESOURCE),
        authorizationServers: ['http://auth.example.com'],
      }),
    'must use https',
    'http issuer'
  );
});

await test('loopback is exempt from the https requirement', () => {
  const doc = buildProtectedResourceMetadata({
    resourceUrl: new URL('http://127.0.0.1:8080/mcp'),
    authorizationServers: ['http://localhost:9000'],
  });
  assertEqual(doc.resource, 'http://127.0.0.1:8080/mcp', 'loopback allowed for local development');
});

// ─── 2. WWW-Authenticate ─────────────────────────────────────────────────────

console.log('\nWWW-Authenticate Challenges\n');

await test('a bare challenge is still a valid Bearer challenge', () => {
  assertEqual(bearerChallenge({}), 'Bearer', 'bare');
});

await test('a challenge carries the metadata URL for discovery', () => {
  const c = bearerChallenge({
    error: 'invalid_token',
    resourceMetadataUrl: protectedResourceMetadataUrl(new URL(RESOURCE)),
  });
  assert(c.includes('error="invalid_token"'), `error: ${c}`);
  assert(c.includes('resource_metadata="https://'), `resource_metadata: ${c}`);
});

await test('an insufficient_scope challenge names the scopes needed', () => {
  const c = bearerChallenge({ error: 'insufficient_scope', requiredScopes: ['admin', 'write'] });
  assert(c.includes('scope="admin write"'), `scope: ${c}`);
});

await test('a quote in the description cannot terminate the field', () => {
  const c = bearerChallenge({ error: 'invalid_token', errorDescription: 'bad "token" here' });
  assert(c.includes('\\"token\\"'), `expected escaped quotes, got: ${c}`);
});

// ─── 3. Bearer Header Parsing ────────────────────────────────────────────────

console.log('\nBearer Header Parsing\n');

await test('a well-formed header yields the token', () => {
  assertEqual(parseBearerToken('Bearer abc.def.ghi'), 'abc.def.ghi', 'token');
});

await test('the scheme is matched case-insensitively', () => {
  assertEqual(parseBearerToken('bearer abc'), 'abc', 'lowercase scheme');
});

await test('a missing header is rejected', () => {
  assertThrows(() => parseBearerToken(undefined), 'Missing Authorization header', 'undefined');
  assertThrows(() => parseBearerToken(''), 'Missing Authorization header', 'empty');
});

await test('a non-Bearer scheme is rejected', () => {
  assertThrows(() => parseBearerToken('Basic dXNlcjpwYXNz'), 'expected', 'basic auth');
});

await test('a scheme with no token is rejected', () => {
  assertThrows(() => parseBearerToken('Bearer'), 'expected', 'no token');
  assertThrows(() => parseBearerToken('Bearer   '), 'expected', 'whitespace only');
});

// ─── 4. Token Claim Validation ───────────────────────────────────────────────

console.log('\nToken Claim Validation\n');

await test('a token for this resource is accepted', () => {
  const info = validateTokenClaims(claims(), { expectedAudience: RESOURCE, expectedIssuers: [ISSUER] });
  assertEqual(info.subject, 'user-1', 'subject');
  assertEqual(info.scopes.join(','), 'read,write', 'scopes');
});

await test('a token minted for a different resource is rejected', () => {
  // The confused-deputy case RFC 8707 exists to prevent: same issuer, wrong
  // audience. Without this check any sibling service's token would work here.
  assertThrows(
    () =>
      validateTokenClaims(claims({ aud: 'https://other.example.com/api' }), {
        expectedAudience: RESOURCE,
      }),
    'audience does not include this resource',
    'wrong audience'
  );
});

await test('a token with no audience at all is rejected', () => {
  assertThrows(
    () => validateTokenClaims(claims({ aud: undefined }), { expectedAudience: RESOURCE }),
    'audience does not include this resource',
    'absent aud'
  );
});

await test('a multi-audience token is accepted when it includes this resource', () => {
  const info = validateTokenClaims(claims({ aud: ['https://other.example.com', RESOURCE] }), {
    expectedAudience: RESOURCE,
  });
  assertEqual(info.subject, 'user-1', 'accepted');
});

await test('an untrusted issuer is rejected', () => {
  assertThrows(
    () =>
      validateTokenClaims(claims({ iss: 'https://evil.example.com' }), {
        expectedAudience: RESOURCE,
        expectedIssuers: [ISSUER],
      }),
    'issuer not trusted',
    'wrong issuer'
  );
});

await test('an expired token is rejected', () => {
  assertThrows(
    () =>
      validateTokenClaims(claims({ exp: 1000 }), { expectedAudience: RESOURCE, nowSec: 2000 }),
    'expired',
    'expired'
  );
});

await test('clock tolerance covers small skew but not a stale token', () => {
  validateTokenClaims(claims({ exp: 1000 }), {
    expectedAudience: RESOURCE,
    nowSec: 1030,
    clockToleranceSec: 60,
  });
  assertThrows(
    () =>
      validateTokenClaims(claims({ exp: 1000 }), {
        expectedAudience: RESOURCE,
        nowSec: 1120,
        clockToleranceSec: 60,
      }),
    'expired',
    'beyond tolerance'
  );
});

await test('a not-yet-valid token is rejected', () => {
  assertThrows(
    () => validateTokenClaims(claims({ nbf: 5000 }), { expectedAudience: RESOURCE, nowSec: 1000 }),
    'not yet valid',
    'nbf'
  );
});

await test('a token missing a required scope raises insufficient_scope', () => {
  try {
    validateTokenClaims(claims({ scope: 'read' }), {
      expectedAudience: RESOURCE,
      requiredScopes: ['write', 'admin'],
    });
  } catch (err) {
    assert(err instanceof InsufficientScopeError, `expected InsufficientScopeError, got ${String(err)}`);
    const missing = (err as InsufficientScopeError).requiredScopes;
    assertEqual(missing.join(','), 'write,admin', 'names only the missing scopes');
    assertEqual((err as InsufficientScopeError).status, 403, 'status is 403, not 401');
    return;
  }
  throw new Error('expected a throw');
});

await test('invalid_token failures are 401', () => {
  try {
    validateTokenClaims(claims({ aud: 'https://other' }), { expectedAudience: RESOURCE });
  } catch (err) {
    assert(err instanceof InvalidTokenError, 'typed error');
    assertEqual((err as InvalidTokenError).status, 401, 'status');
    return;
  }
  throw new Error('expected a throw');
});

await test('authenticateBearer runs parse, verify and claim checks together', async () => {
  const info = await authenticateBearer(
    'Bearer good.token',
    { verify: async () => claims() },
    { expectedAudience: RESOURCE, expectedIssuers: [ISSUER] }
  );
  assertEqual(info.subject, 'user-1', 'subject');
});

await test('a verifier failure becomes invalid_token, not a leaked internal error', async () => {
  let caught: unknown;
  try {
    await authenticateBearer(
      'Bearer forged',
      {
        verify: async () => {
          throw new Error('signature mismatch on key kid=abc');
        },
      },
      { expectedAudience: RESOURCE }
    );
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof InvalidTokenError, `expected InvalidTokenError, got ${String(caught)}`);
  assertEqual((caught as InvalidTokenError).code, 'invalid_token', 'code');
});

await test('claim checks still run after a successful signature verification', async () => {
  // A verifier that says "authentic" must not be able to bypass the audience
  // check — a valid signature on a token for another resource is still invalid.
  let caught: unknown;
  try {
    await authenticateBearer(
      'Bearer valid.but.wrong.audience',
      { verify: async () => claims({ aud: 'https://other.example.com' }) },
      { expectedAudience: RESOURCE }
    );
  } catch (err) {
    caught = err;
  }
  assert(
    caught instanceof InvalidTokenError && String(caught).includes('audience'),
    `expected an audience rejection, got ${String(caught)}`
  );
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
