/**
 * Inbound resource-server authorization (MCP 2026-07-28, RFC 9728 / RFC 8707).
 *
 * Under 2026-07-28 a server that accepts bearer tokens takes on the OAuth
 * *resource server* role: it must publish RFC 9728 Protected Resource Metadata
 * so clients can discover its authorization server, and it must
 * audience-validate every token it accepts (RFC 8707).
 *
 * ## Why this module exists but nothing calls it yet
 *
 * This gateway is stdio-only: its trust boundary is the process that spawned
 * it, and there is no inbound HTTP to authenticate. Opening a listener is a
 * deployment decision, so this module deliberately ships **inert** — pure
 * functions with no network surface, no port, and no route table. It is the
 * part of the work that is the same regardless of how a listener is eventually
 * wired, and it is verifiable on its own.
 *
 * ## What it deliberately does not do
 *
 * It does not verify JWT signatures. That needs JWKS retrieval, key rotation
 * and algorithm pinning — easy to get subtly wrong, and wrong here means
 * accepting forged tokens. Signature verification is supplied by the caller
 * through {@link TokenVerifier}; this module owns the claim checks, which is
 * where the MCP-specific requirements actually live.
 */

// ─── Errors ─────────────────────────────────────────────────────────────────

/** RFC 6750 error codes usable in a `WWW-Authenticate` challenge. */
export type BearerErrorCode = 'invalid_token' | 'insufficient_scope' | 'invalid_request';

export class BearerAuthError extends Error {
  constructor(
    readonly code: BearerErrorCode,
    message: string,
    /** HTTP status a transport should return for this failure. */
    readonly status: number
  ) {
    super(message);
    this.name = 'BearerAuthError';
  }
}

export class InvalidTokenError extends BearerAuthError {
  constructor(message: string) {
    super('invalid_token', message, 401);
  }
}

export class InsufficientScopeError extends BearerAuthError {
  constructor(
    message: string,
    readonly requiredScopes: readonly string[]
  ) {
    super('insufficient_scope', message, 403);
  }
}

// ─── RFC 9728 Protected Resource Metadata ───────────────────────────────────

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  jwks_uri?: string;
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  resource_name?: string;
  resource_documentation?: string;
}

export interface ProtectedResourceMetadataOptions {
  /** Canonical URL identifying this resource server — the token audience. */
  resourceUrl: URL;
  /** Issuer identifiers of the authorization servers this resource trusts. */
  authorizationServers: string[];
  scopesSupported?: string[];
  resourceName?: string;
  resourceDocumentation?: string;
}

/**
 * Path at which the metadata document must be served (RFC 9728 §3).
 *
 * The resource's own path is appended, so one host can serve several
 * independently-authorized resources. A root resource contributes no suffix.
 */
export function protectedResourceMetadataPath(resourceUrl: URL): string {
  const path = stripTrailingSlash(resourceUrl.pathname);
  return `/.well-known/oauth-protected-resource${path === '/' ? '' : path}`;
}

/** Absolute URL of the metadata document for a resource. */
export function protectedResourceMetadataUrl(resourceUrl: URL): string {
  return new URL(protectedResourceMetadataPath(resourceUrl), resourceUrl).href;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Build the metadata document.
 *
 * Rejects a non-HTTPS resource or issuer: these values tell a client where to
 * send credentials, so publishing a plaintext one invites interception.
 * Loopback is exempt, since it cannot leave the host.
 */
export function buildProtectedResourceMetadata(
  options: ProtectedResourceMetadataOptions
): ProtectedResourceMetadata {
  assertSecureUrl(options.resourceUrl, 'resource');
  for (const issuer of options.authorizationServers) {
    assertSecureUrl(new URL(issuer), 'authorization server');
  }
  return {
    resource: options.resourceUrl.href,
    authorization_servers: options.authorizationServers,
    ...(options.scopesSupported ? { scopes_supported: options.scopesSupported } : {}),
    // Header-only: query-string tokens land in logs and Referer headers.
    bearer_methods_supported: ['header'],
    ...(options.resourceName ? { resource_name: options.resourceName } : {}),
    ...(options.resourceDocumentation ? { resource_documentation: options.resourceDocumentation } : {}),
  };
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

function assertSecureUrl(url: URL, label: string): void {
  if (url.protocol !== 'https:' && !isLoopback(url)) {
    throw new Error(`${label} URL must use https (got ${url.protocol.replace(':', '')}): ${url.href}`);
  }
}

// ─── WWW-Authenticate challenge ─────────────────────────────────────────────

/**
 * Build the `WWW-Authenticate` value for a rejected request.
 *
 * `resource_metadata` is what lets a client that has never talked to this
 * server discover where to authenticate, so a challenge should carry it.
 */
export function bearerChallenge(options: {
  error?: BearerErrorCode;
  errorDescription?: string;
  requiredScopes?: readonly string[];
  resourceMetadataUrl?: string;
}): string {
  const parts: string[] = [];
  if (options.error) parts.push(`error="${options.error}"`);
  if (options.errorDescription) parts.push(`error_description="${escapeQuoted(options.errorDescription)}"`);
  if (options.requiredScopes && options.requiredScopes.length > 0) {
    parts.push(`scope="${options.requiredScopes.join(' ')}"`);
  }
  if (options.resourceMetadataUrl) parts.push(`resource_metadata="${options.resourceMetadataUrl}"`);
  return parts.length > 0 ? `Bearer ${parts.join(', ')}` : 'Bearer';
}

/** Escape a quoted-string value so it cannot terminate the field early. */
function escapeQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ─── Token validation ───────────────────────────────────────────────────────

/** Claims this module inspects. Anything else passes through untouched. */
export interface AccessTokenClaims {
  iss?: string;
  /** RFC 7519 audience — a single value or a list. */
  aud?: string | string[];
  /** Expiry, seconds since the epoch. */
  exp?: number;
  /** Not-before, seconds since the epoch. */
  nbf?: number;
  /** Space-delimited granted scopes (RFC 8693). */
  scope?: string;
  sub?: string;
}

/**
 * Supplies signature verification. An implementation must reject a token whose
 * signature does not verify against a trusted key — returning its claims here
 * asserts the token is authentic, and this module trusts that.
 */
export interface TokenVerifier {
  verify(token: string): Promise<AccessTokenClaims>;
}

export interface TokenValidationOptions {
  /** Canonical resource URL this server accepts tokens for (RFC 8707). */
  expectedAudience: string;
  /** Trusted issuer identifiers; a token from anyone else is rejected. */
  expectedIssuers?: string[];
  requiredScopes?: readonly string[];
  /** Clock skew allowance, in seconds. */
  clockToleranceSec?: number;
  /** Injectable clock, in seconds since the epoch. */
  nowSec?: number;
}

export interface AuthInfo {
  subject?: string;
  scopes: string[];
  claims: AccessTokenClaims;
}

/** Extract the token from an `Authorization` header. */
export function parseBearerToken(authorizationHeader: string | undefined | null): string {
  if (!authorizationHeader) throw new InvalidTokenError('Missing Authorization header');
  const [scheme, ...rest] = authorizationHeader.trim().split(/\s+/);
  const token = rest.join('');
  if (scheme?.toLowerCase() !== 'bearer' || token.length === 0) {
    throw new InvalidTokenError("Invalid Authorization header format, expected 'Bearer TOKEN'");
  }
  return token;
}

/**
 * Validate the claims of an already-signature-verified token.
 *
 * The audience check is the load-bearing one: without it this server would
 * accept any token the same authorization server issued for *any* resource,
 * so a token minted for a different service would grant access here — the
 * confused-deputy problem RFC 8707 exists to prevent.
 */
export function validateTokenClaims(
  claims: AccessTokenClaims,
  options: TokenValidationOptions
): AuthInfo {
  const now = options.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockToleranceSec ?? 0;

  if (options.expectedIssuers && options.expectedIssuers.length > 0) {
    if (!claims.iss || !options.expectedIssuers.includes(claims.iss)) {
      throw new InvalidTokenError(`Token issuer not trusted: ${claims.iss ?? '(absent)'}`);
    }
  }

  const audiences = claims.aud === undefined ? [] : Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.expectedAudience)) {
    throw new InvalidTokenError(
      `Token audience does not include this resource (${options.expectedAudience})`
    );
  }

  if (claims.exp !== undefined && now > claims.exp + tolerance) {
    throw new InvalidTokenError('Token has expired');
  }
  if (claims.nbf !== undefined && now + tolerance < claims.nbf) {
    throw new InvalidTokenError('Token is not yet valid');
  }

  const scopes = claims.scope ? claims.scope.trim().split(/\s+/).filter((s) => s.length > 0) : [];
  if (options.requiredScopes && options.requiredScopes.length > 0) {
    const missing = options.requiredScopes.filter((s) => !scopes.includes(s));
    if (missing.length > 0) {
      // 403 with the scopes needed, so the client can step up rather than guess.
      throw new InsufficientScopeError(`Token is missing required scope(s): ${missing.join(' ')}`, missing);
    }
  }

  return { subject: claims.sub, scopes, claims };
}

/** Verify a bearer header end to end: parse, check signature, check claims. */
export async function authenticateBearer(
  authorizationHeader: string | undefined | null,
  verifier: TokenVerifier,
  options: TokenValidationOptions
): Promise<AuthInfo> {
  const token = parseBearerToken(authorizationHeader);
  let claims: AccessTokenClaims;
  try {
    claims = await verifier.verify(token);
  } catch (err) {
    // Never surface verifier internals to a caller holding a bad token.
    throw new InvalidTokenError(`Token verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateTokenClaims(claims, options);
}
