/**
 * JWKS-backed access token signature verification.
 *
 * `resource-auth.ts` owns the claim checks (audience, issuer, expiry, scope)
 * and deliberately delegates signature verification through its
 * {@link TokenVerifier} interface. This module is the production
 * implementation of that interface, and it lives apart so `resource-auth.ts`
 * stays dependency-free and unit-testable without a key server.
 *
 * Built on `jose` rather than hand-rolled: verifying a JWT correctly means
 * getting algorithm pinning, `kid` selection, key rotation and JWKS caching
 * right, and each of those is a way to accept a forged token if implemented
 * casually.
 *
 * Two rules this module enforces that a naive verifier misses:
 *
 *   - **Algorithms are pinned by the server, never read from the token.**
 *     Trusting the token's own `alg` is what makes `alg: "none"` and
 *     RS256→HS256 confusion attacks work.
 *   - **`iss` and `aud` are checked here as well as in the claim layer.**
 *     Belt and braces: this module can reject before the claim layer runs, and
 *     `validateTokenClaims` still re-checks so neither layer is load-bearing
 *     alone.
 */

import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose';
import type { AccessTokenClaims, TokenVerifier } from './resource-auth.js';

/**
 * Signature algorithms accepted by default: asymmetric only.
 *
 * Symmetric algorithms (HS*) are excluded deliberately — with a JWKS the
 * verification key is public, so accepting HS256 would let anyone who can read
 * the JWKS mint tokens we would then trust.
 */
export const DEFAULT_ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256'] as const;

export interface JwksVerifierOptions {
  /** JWKS endpoint of the authorization server. Must be HTTPS (or loopback). */
  jwksUri: URL;
  /** Expected `iss`. Rejected before the claim layer when it does not match. */
  issuer?: string;
  /** Expected `aud` — this resource's canonical URL (RFC 8707). */
  audience?: string;
  /** Signature algorithms to accept. Defaults to asymmetric-only. */
  allowedAlgorithms?: readonly string[];
  /** Clock skew allowance, in seconds. */
  clockToleranceSec?: number;
}

export class JwksVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwksVerificationError';
  }
}

/**
 * Verifies access tokens against a remote JWKS.
 *
 * The key set is fetched lazily and cached by `jose`, which also handles
 * re-fetching on an unknown `kid` (so key rotation does not require a restart)
 * with its own rate limiting (so an unknown-kid flood cannot be turned into a
 * request amplifier against the authorization server).
 */
export class JwksTokenVerifier implements TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly algorithms: string[];

  constructor(private readonly options: JwksVerifierOptions) {
    assertSecureJwksUri(options.jwksUri);
    this.algorithms = [...(options.allowedAlgorithms ?? DEFAULT_ALLOWED_ALGORITHMS)];
    if (this.algorithms.length === 0) {
      throw new JwksVerificationError('allowedAlgorithms must not be empty — an empty list accepts nothing');
    }
    for (const alg of this.algorithms) {
      if (alg.toLowerCase() === 'none' || alg.startsWith('HS')) {
        throw new JwksVerificationError(
          `refusing to allow ${alg}: a JWKS key is public, so a symmetric or unsigned algorithm would let any reader mint tokens`
        );
      }
    }
    this.jwks = createRemoteJWKSet(options.jwksUri);
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    // Reject a disallowed algorithm before touching the key set, so a token
    // asking for `none` never reaches key resolution.
    let header: { alg?: string };
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new JwksVerificationError('token is not a well-formed JWS');
    }
    if (!header.alg || !this.algorithms.includes(header.alg)) {
      throw new JwksVerificationError(`unsupported token signature algorithm: ${header.alg ?? '(absent)'}`);
    }

    const { payload } = await jwtVerify(token, this.jwks, {
      algorithms: this.algorithms,
      ...(this.options.issuer ? { issuer: this.options.issuer } : {}),
      ...(this.options.audience ? { audience: this.options.audience } : {}),
      ...(this.options.clockToleranceSec !== undefined ? { clockTolerance: this.options.clockToleranceSec } : {}),
    });

    return payload as AccessTokenClaims;
  }
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/**
 * A plaintext JWKS URI would let a network attacker substitute their own keys,
 * which defeats signature verification entirely. Loopback is exempt so local
 * development against a test issuer works.
 */
function assertSecureJwksUri(url: URL): void {
  if (url.protocol !== 'https:' && !isLoopback(url)) {
    throw new JwksVerificationError(
      `JWKS URI must use https (got ${url.protocol.replace(':', '')}): ${url.href}`
    );
  }
}
