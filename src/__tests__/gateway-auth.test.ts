/**
 * Gateway Inbound Authorization Tests (RFC 9728 / RFC 8707, MCP 2026-07-28)
 *
 * Hand-rolled runner (same pattern as sandbox.test.ts).
 * Import from .js extensions, run from dist/.
 *
 * Test groups:
 * 1. Mode resolution from environment
 * 2. static-token mode — including the timing-safe comparison
 * 3. oauth mode — audience/issuer/scope enforcement and challenges
 * 4. Metadata document + path
 * 5. JWKS verifier — real signatures against a generated keypair
 */

import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  resolveGatewayAuth,
  authorizeGatewayRequest,
  gatewayMetadataPath,
  gatewayMetadataDocument,
  createGatewayVerifier,
  GatewayAuthConfigError,
  type GatewayAuthConfig,
} from '../gateway-auth.js';
import { JwksTokenVerifier, JwksVerificationError } from '../jwks-verifier.js';
import type { AccessTokenClaims, TokenVerifier } from '../resource-auth.js';

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

const RESOURCE = 'https://mcp.example.com/mcp';
const ISSUER = 'https://auth.example.com';

function claims(over: Partial<AccessTokenClaims> = {}): AccessTokenClaims {
  return { iss: ISSUER, aud: RESOURCE, sub: 'user-1', scope: 'read write', ...over };
}

/** A verifier that returns fixed claims without checking any signature. */
function fakeVerifier(c: AccessTokenClaims): TokenVerifier {
  return { verify: async () => c };
}

const OAUTH_ENV = {
  METAMCP_RESOURCE_URL: RESOURCE,
  METAMCP_AUTH_ISSUER: ISSUER,
};

// ─── 1. Mode Resolution ──────────────────────────────────────────────────────

console.log('Mode Resolution\n');

await test('no auth env resolves to open mode', () => {
  assertEqual(resolveGatewayAuth({}).mode, 'open', 'mode');
});

await test('a bearer token alone resolves to static-token mode', () => {
  const c = resolveGatewayAuth({ METAMCP_HTTP_BEARER_TOKEN: 'secret' });
  assertEqual(c.mode, 'static-token', 'mode');
  assertEqual(c.staticToken, 'secret', 'token');
});

await test('resource + issuer resolves to oauth mode', () => {
  const c = resolveGatewayAuth(OAUTH_ENV);
  assertEqual(c.mode, 'oauth', 'mode');
  // Kept verbatim: RFC 8414 issuers are compared byte-for-byte, and appending a
  // trailing slash here would make every real token's `iss` mismatch.
  assertEqual(c.issuer, ISSUER, 'issuer preserved exactly as configured');
  assertEqual(c.resourceUrl?.href, RESOURCE, 'resource');
});

await test('a bare-origin issuer is not slash-normalised', () => {
  // `new URL('https://x').href` is 'https://x/'. Storing that as the issuer
  // broke end-to-end verification against a token whose iss had no slash.
  const c = resolveGatewayAuth({ METAMCP_RESOURCE_URL: RESOURCE, METAMCP_AUTH_ISSUER: 'https://auth.example.com' });
  assertEqual(c.issuer, 'https://auth.example.com', 'no trailing slash added');
  // The JWKS path still derives correctly from it.
  assertEqual(c.jwksUri?.href, 'https://auth.example.com/.well-known/jwks.json', 'jwks derivation unaffected');
});

await test('oauth outranks a static token when both are set', () => {
  // Accepting either credential would let the weaker one define the endpoint's
  // security, so the modes are exclusive rather than combined.
  const c = resolveGatewayAuth({ ...OAUTH_ENV, METAMCP_HTTP_BEARER_TOKEN: 'secret' });
  assertEqual(c.mode, 'oauth', 'mode');
  assertEqual(c.staticToken, undefined, 'static token not carried into oauth mode');
});

await test('half-configured oauth is refused, not downgraded', () => {
  // Silently falling back to open/static would be the opposite of intent.
  assertThrows(
    () => resolveGatewayAuth({ METAMCP_AUTH_ISSUER: ISSUER }),
    'METAMCP_RESOURCE_URL is not',
    'issuer without resource'
  );
  assertThrows(
    () => resolveGatewayAuth({ METAMCP_RESOURCE_URL: RESOURCE }),
    'METAMCP_AUTH_ISSUER is not',
    'resource without issuer'
  );
});

await test('an invalid URL is reported as config error', () => {
  assertThrows(
    () => resolveGatewayAuth({ METAMCP_RESOURCE_URL: 'not a url', METAMCP_AUTH_ISSUER: ISSUER }),
    'not a valid URL',
    'bad resource url'
  );
});

await test('jwks uri defaults from the issuer and can be overridden', () => {
  assertEqual(
    resolveGatewayAuth(OAUTH_ENV).jwksUri?.href,
    'https://auth.example.com/.well-known/jwks.json',
    'derived jwks'
  );
  assertEqual(
    resolveGatewayAuth({ ...OAUTH_ENV, METAMCP_AUTH_JWKS_URI: 'https://keys.example.com/jwks' }).jwksUri?.href,
    'https://keys.example.com/jwks',
    'explicit jwks'
  );
});

await test('required scopes accept space or comma delimiting', () => {
  assertEqual(
    resolveGatewayAuth({ ...OAUTH_ENV, METAMCP_AUTH_REQUIRED_SCOPES: 'read, write' }).requiredScopes.join(','),
    'read,write',
    'scopes'
  );
});

// ─── 2. static-token Mode ────────────────────────────────────────────────────

console.log('\nstatic-token Mode\n');

const staticConfig = resolveGatewayAuth({ METAMCP_HTTP_BEARER_TOKEN: 'smoke-token' });

await test('open mode admits every request', async () => {
  const d = await authorizeGatewayRequest(resolveGatewayAuth({}), {});
  assertEqual(d.ok, true, 'ok');
});

await test('Authorization: Bearer is accepted', async () => {
  const d = await authorizeGatewayRequest(staticConfig, { authorization: 'Bearer smoke-token' });
  assertEqual(d.ok, true, 'ok');
});

await test('X-MetaMCP-Token is accepted', async () => {
  const d = await authorizeGatewayRequest(staticConfig, { 'x-metamcp-token': 'smoke-token' });
  assertEqual(d.ok, true, 'ok');
});

await test('a wrong or absent token is rejected with a challenge', async () => {
  const wrong = await authorizeGatewayRequest(staticConfig, { authorization: 'Bearer nope' });
  assertEqual(wrong.ok, false, 'wrong token rejected');
  assertEqual(wrong.status, 401, 'status');
  assert(wrong.challenge?.startsWith('Bearer') === true, `challenge: ${wrong.challenge}`);
  const absent = await authorizeGatewayRequest(staticConfig, {});
  assertEqual(absent.ok, false, 'absent token rejected');
});

await test('a token differing only in length is rejected without throwing', async () => {
  // The comparison is constant-time and length-safe; timingSafeEqual throws on
  // unequal lengths if not guarded, which would surface as a 500.
  const d = await authorizeGatewayRequest(staticConfig, { authorization: 'Bearer smoke-token-longer' });
  assertEqual(d.ok, false, 'rejected');
  assertEqual(d.status, 401, 'still a 401, not a crash');
});

// ─── 3. oauth Mode ───────────────────────────────────────────────────────────

console.log('\noauth Mode\n');

const oauthConfig: GatewayAuthConfig = resolveGatewayAuth(OAUTH_ENV);

await test('a token for this resource from the trusted issuer is accepted', async () => {
  const d = await authorizeGatewayRequest(
    oauthConfig,
    { authorization: 'Bearer t' },
    fakeVerifier(claims({ iss: oauthConfig.issuer }))
  );
  assertEqual(d.ok, true, `ok (${d.errorDescription})`);
  assertEqual(d.subject, 'user-1', 'subject surfaced');
  assertEqual(d.scopes?.join(','), 'read,write', 'scopes surfaced');
});

await test('a token minted for another resource is rejected', async () => {
  // RFC 8707: same issuer, wrong audience — the confused-deputy case.
  const d = await authorizeGatewayRequest(
    oauthConfig,
    { authorization: 'Bearer t' },
    fakeVerifier(claims({ iss: oauthConfig.issuer, aud: 'https://other.example.com/api' }))
  );
  assertEqual(d.ok, false, 'rejected');
  assertEqual(d.status, 401, 'status');
  assert(d.challenge?.includes('resource_metadata=') === true, `challenge advertises metadata: ${d.challenge}`);
});

await test('a token from an untrusted issuer is rejected', async () => {
  const d = await authorizeGatewayRequest(
    oauthConfig,
    { authorization: 'Bearer t' },
    fakeVerifier(claims({ iss: 'https://evil.example.com' }))
  );
  assertEqual(d.ok, false, 'rejected');
});

await test('a missing scope yields 403 with the scopes named', async () => {
  const scoped = resolveGatewayAuth({ ...OAUTH_ENV, METAMCP_AUTH_REQUIRED_SCOPES: 'admin' });
  const d = await authorizeGatewayRequest(
    scoped,
    { authorization: 'Bearer t' },
    fakeVerifier(claims({ iss: scoped.issuer, scope: 'read' }))
  );
  assertEqual(d.ok, false, 'rejected');
  assertEqual(d.status, 403, 'insufficient_scope is 403, not 401');
  assert(d.challenge?.includes('scope="admin"') === true, `challenge names the scope: ${d.challenge}`);
});

await test('a missing Authorization header is rejected with a discovery challenge', async () => {
  const d = await authorizeGatewayRequest(oauthConfig, {}, fakeVerifier(claims()));
  assertEqual(d.ok, false, 'rejected');
  assert(d.challenge?.includes('resource_metadata=') === true, `challenge: ${d.challenge}`);
});

await test('a static token is not accepted in oauth mode', async () => {
  // The shared secret must not remain a back door once OAuth is configured.
  const d = await authorizeGatewayRequest(
    oauthConfig,
    { 'x-metamcp-token': 'smoke-token' },
    fakeVerifier(claims({ iss: oauthConfig.issuer }))
  );
  assertEqual(d.ok, false, 'rejected — no Authorization header present');
});

await test('a verifier failure becomes invalid_token, not a 500', async () => {
  const d = await authorizeGatewayRequest(
    oauthConfig,
    { authorization: 'Bearer forged' },
    { verify: async () => { throw new Error('signature mismatch'); } }
  );
  assertEqual(d.ok, false, 'rejected');
  assertEqual(d.status, 401, 'status');
  assertEqual(d.error, 'invalid_token', 'error code');
});

await test('oauth mode with no verifier refuses rather than admits', async () => {
  const d = await authorizeGatewayRequest(oauthConfig, { authorization: 'Bearer t' });
  assertEqual(d.ok, false, 'refused');
  assertEqual(d.status, 500, 'reported as a server fault, not an auth pass');
});

// ─── 4. Metadata Document ────────────────────────────────────────────────────

console.log('\nMetadata Document\n');

await test('the metadata path is served only in oauth mode', () => {
  assertEqual(gatewayMetadataPath(oauthConfig), '/.well-known/oauth-protected-resource/mcp', 'oauth');
  assertEqual(gatewayMetadataPath(staticConfig), null, 'static-token');
  assertEqual(gatewayMetadataPath(resolveGatewayAuth({})), null, 'open');
});

await test('the document names the resource and authorization server', () => {
  const doc = gatewayMetadataDocument(oauthConfig);
  assertEqual(doc?.resource, RESOURCE, 'resource');
  assertEqual(doc?.authorization_servers?.[0], oauthConfig.issuer, 'authorization_servers');
  assertEqual(doc?.bearer_methods_supported?.join(','), 'header', 'header-only tokens');
});

await test('supported scopes are advertised when configured', () => {
  const c = resolveGatewayAuth({ ...OAUTH_ENV, METAMCP_AUTH_SUPPORTED_SCOPES: 'read write admin' });
  assertEqual(gatewayMetadataDocument(c)?.scopes_supported?.join(','), 'read,write,admin', 'scopes_supported');
});

await test('no document outside oauth mode', () => {
  assertEqual(gatewayMetadataDocument(staticConfig), null, 'static-token');
});

// ─── 5. JWKS Verifier (real signatures) ──────────────────────────────────────

console.log('\nJWKS Verifier\n');

await test('a plaintext JWKS URI is refused', () => {
  // A network attacker could substitute their own keys, defeating verification.
  assertThrows(
    () => new JwksTokenVerifier({ jwksUri: new URL('http://keys.example.com/jwks') }),
    'must use https',
    'http jwks'
  );
});

await test('symmetric and unsigned algorithms are refused', () => {
  // With a JWKS the key is public, so HS256 would let any reader mint tokens.
  assertThrows(
    () => new JwksTokenVerifier({ jwksUri: new URL('https://k/jwks'), allowedAlgorithms: ['HS256'] }),
    'refusing to allow HS256',
    'HS256'
  );
  assertThrows(
    () => new JwksTokenVerifier({ jwksUri: new URL('https://k/jwks'), allowedAlgorithms: ['none'] }),
    'refusing to allow none',
    'alg none'
  );
});

await test('an empty algorithm list is refused', () => {
  assertThrows(
    () => new JwksTokenVerifier({ jwksUri: new URL('https://k/jwks'), allowedAlgorithms: [] }),
    'must not be empty',
    'empty list'
  );
});

// A loopback JWKS server standing in for a real authorization server.
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
jwk.kid = 'test-key-1';
jwk.alg = 'RS256';
jwk.use = 'sig';

const otherPair = await generateKeyPair('RS256');

let jwksServer: Server | undefined;
const jwksPort = await new Promise<number>((res, rej) => {
  jwksServer = createServer((_req, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  jwksServer.once('error', rej);
  jwksServer.listen(0, '127.0.0.1', () => res((jwksServer!.address() as AddressInfo).port));
});
const jwksUri = new URL(`http://127.0.0.1:${jwksPort}/jwks`);

async function signToken(key: CryptoKey | Uint8Array, over: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ scope: 'read write', ...over })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key as CryptoKey);
}

await test('a genuinely signed token verifies', async () => {
  const verifier = new JwksTokenVerifier({ jwksUri, issuer: ISSUER, audience: RESOURCE });
  const verified = await verifier.verify(await signToken(privateKey));
  assertEqual(verified.sub, 'user-1', 'subject');
  assertEqual(verified.iss, ISSUER, 'issuer');
});

await test('a token signed by the wrong key is rejected', async () => {
  const verifier = new JwksTokenVerifier({ jwksUri, issuer: ISSUER, audience: RESOURCE });
  const forged = await signToken(otherPair.privateKey);
  let threw = false;
  try {
    await verifier.verify(forged);
  } catch {
    threw = true;
  }
  assert(threw, 'a signature from an untrusted key must not verify');
});

await test('a tampered payload is rejected', async () => {
  const verifier = new JwksTokenVerifier({ jwksUri, issuer: ISSUER, audience: RESOURCE });
  const token = await signToken(privateKey);
  const [h, , s] = token.split('.');
  const tampered = `${h}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: RESOURCE, sub: 'admin' })).toString('base64url')}.${s}`;
  let threw = false;
  try {
    await verifier.verify(tampered);
  } catch {
    threw = true;
  }
  assert(threw, 'editing the payload must invalidate the signature');
});

await test('an expired token is rejected', async () => {
  const verifier = new JwksTokenVerifier({ jwksUri, issuer: ISSUER, audience: RESOURCE });
  const expired = await new SignJWT({ scope: 'read' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setIssuedAt(1000)
    .setExpirationTime(2000)
    .sign(privateKey);
  let threw = false;
  try {
    await verifier.verify(expired);
  } catch {
    threw = true;
  }
  assert(threw, 'expired token must be rejected');
});

await test('a token for the wrong audience is rejected by the verifier too', async () => {
  // Belt and braces: the claim layer also checks this, so neither is load-bearing alone.
  const verifier = new JwksTokenVerifier({ jwksUri, issuer: ISSUER, audience: RESOURCE });
  const wrongAud = await new SignJWT({ scope: 'read' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuer(ISSUER)
    .setAudience('https://other.example.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  let threw = false;
  try {
    await verifier.verify(wrongAud);
  } catch {
    threw = true;
  }
  assert(threw, 'wrong audience must be rejected');
});

await test('a malformed token is reported as such', async () => {
  const verifier = new JwksTokenVerifier({ jwksUri });
  let msg = '';
  try {
    await verifier.verify('not-a-jwt');
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  assert(msg.includes('not a well-formed JWS'), `unexpected message: ${msg}`);
});

await test('the gateway accepts a real signed token end to end', async () => {
  // Full path: resolveGatewayAuth -> JwksTokenVerifier -> claim validation.
  const config = resolveGatewayAuth({
    METAMCP_RESOURCE_URL: RESOURCE,
    METAMCP_AUTH_ISSUER: ISSUER,
    METAMCP_AUTH_JWKS_URI: jwksUri.href,
    METAMCP_AUTH_REQUIRED_SCOPES: 'read',
  });
  const verifier = createGatewayVerifier(config);
  assert(verifier !== undefined, 'verifier built for oauth mode');
  const decision = await authorizeGatewayRequest(
    config,
    { authorization: `Bearer ${await signToken(privateKey)}` },
    verifier
  );
  assertEqual(decision.ok, true, `accepted (${decision.errorDescription ?? ''})`);
  assertEqual(decision.subject, 'user-1', 'subject');
});

await test('the gateway rejects a forged token end to end', async () => {
  const config = resolveGatewayAuth({
    METAMCP_RESOURCE_URL: RESOURCE,
    METAMCP_AUTH_ISSUER: ISSUER,
    METAMCP_AUTH_JWKS_URI: jwksUri.href,
  });
  const decision = await authorizeGatewayRequest(
    config,
    { authorization: `Bearer ${await signToken(otherPair.privateKey)}` },
    createGatewayVerifier(config)
  );
  assertEqual(decision.ok, false, 'rejected');
  assertEqual(decision.error, 'invalid_token', 'error code');
});

jwksServer?.close();

// Referenced so the import is not flagged as unused when assertions change.
void GatewayAuthConfigError;
void JwksVerificationError;

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
}
