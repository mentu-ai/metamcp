/**
 * Inbound authorization for the Streamable HTTP gateway.
 *
 * The HTTP surface shipped with a single shared secret compared with `===`
 * against `METAMCP_HTTP_BEARER_TOKEN`. That is fine for a private Cloud Run
 * deployment behind IAM, but it is not what MCP 2026-07-28 asks of a server
 * that accepts bearer tokens: such a server takes the OAuth *resource server*
 * role, must publish RFC 9728 Protected Resource Metadata so clients can
 * discover where to authenticate, and must audience-validate tokens (RFC 8707)
 * so a token minted for another service cannot be replayed here.
 *
 * This module resolves which of three modes a deployment is in, from
 * environment alone, and answers requests accordingly:
 *
 *   - **oauth** — `METAMCP_RESOURCE_URL` + issuer configured. JWT bearer
 *     tokens are signature-verified against the issuer's JWKS and
 *     audience-validated; the metadata document is served; failures carry a
 *     `WWW-Authenticate` challenge.
 *   - **static-token** — only `METAMCP_HTTP_BEARER_TOKEN` set. Previous
 *     behaviour, with the comparison made timing-safe.
 *   - **open** — neither configured. Previous default, unchanged.
 *
 * The modes are deliberately not combinable: accepting a static secret *or* a
 * verified token would mean the weaker credential silently defines the
 * security of the endpoint.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  buildProtectedResourceMetadata,
  protectedResourceMetadataPath,
  protectedResourceMetadataUrl,
  bearerChallenge,
  parseBearerToken,
  validateTokenClaims,
  BearerAuthError,
  InvalidTokenError,
  type ProtectedResourceMetadata,
  type TokenVerifier,
} from './resource-auth.js';
import { JwksTokenVerifier } from './jwks-verifier.js';

export type GatewayAuthMode = 'open' | 'static-token' | 'oauth';

export interface GatewayAuthEnv {
  METAMCP_HTTP_BEARER_TOKEN?: string;
  /** Canonical URL identifying this resource server — the expected audience. */
  METAMCP_RESOURCE_URL?: string;
  /** Issuer identifier of the trusted authorization server. */
  METAMCP_AUTH_ISSUER?: string;
  /** JWKS endpoint. Defaults to the issuer's conventional JWKS path. */
  METAMCP_AUTH_JWKS_URI?: string;
  /** Space- or comma-delimited scopes every request must carry. */
  METAMCP_AUTH_REQUIRED_SCOPES?: string;
  /** Advertised in the metadata document; informational. */
  METAMCP_AUTH_SUPPORTED_SCOPES?: string;
}

export interface GatewayAuthConfig {
  mode: GatewayAuthMode;
  /** Populated in oauth mode. */
  resourceUrl?: URL;
  issuer?: string;
  jwksUri?: URL;
  requiredScopes: string[];
  supportedScopes?: string[];
  /** Populated in static-token mode. */
  staticToken?: string;
}

export class GatewayAuthConfigError extends Error {}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s,]+/).filter((s) => s.length > 0);
}

/**
 * Conventional JWKS location for an issuer, used when none is configured.
 * OIDC providers publish `jwks_uri` in their discovery document; deriving the
 * common path avoids a network round-trip at startup while
 * `METAMCP_AUTH_JWKS_URI` remains available for issuers that differ.
 */
function defaultJwksUri(issuer: string): URL {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  return new URL('.well-known/jwks.json', base);
}

/** Resolve the auth mode and its settings from the environment. */
export function resolveGatewayAuth(env: GatewayAuthEnv): GatewayAuthConfig {
  const resource = env.METAMCP_RESOURCE_URL?.trim();
  const issuer = env.METAMCP_AUTH_ISSUER?.trim();
  const staticToken = env.METAMCP_HTTP_BEARER_TOKEN;

  if (resource || issuer) {
    // Half-configured OAuth is refused rather than quietly downgraded: falling
    // back to a static token or to open would be the opposite of the operator's
    // evident intent.
    if (!resource) {
      throw new GatewayAuthConfigError(
        'METAMCP_AUTH_ISSUER is set but METAMCP_RESOURCE_URL is not — the resource URL is the token audience and cannot be inferred'
      );
    }
    if (!issuer) {
      throw new GatewayAuthConfigError(
        'METAMCP_RESOURCE_URL is set but METAMCP_AUTH_ISSUER is not — there is no authorization server to trust'
      );
    }

    let resourceUrl: URL;
    let issuerUrl: URL;
    try {
      resourceUrl = new URL(resource);
    } catch {
      throw new GatewayAuthConfigError(`METAMCP_RESOURCE_URL is not a valid URL: ${resource}`);
    }
    try {
      issuerUrl = new URL(issuer);
    } catch {
      throw new GatewayAuthConfigError(`METAMCP_AUTH_ISSUER is not a valid URL: ${issuer}`);
    }

    const jwksUri = env.METAMCP_AUTH_JWKS_URI?.trim()
      ? new URL(env.METAMCP_AUTH_JWKS_URI.trim())
      : defaultJwksUri(issuerUrl.href);

    return {
      mode: 'oauth',
      resourceUrl,
      // The configured string verbatim, NOT `issuerUrl.href`. RFC 8414 issuer
      // identifiers are compared byte-for-byte, and URL normalisation appends a
      // trailing slash to a bare origin — enough to make every real token's
      // `iss` mismatch. The parsed URL is used only to derive the JWKS path.
      issuer: issuer,
      jwksUri,
      requiredScopes: splitList(env.METAMCP_AUTH_REQUIRED_SCOPES),
      supportedScopes: splitList(env.METAMCP_AUTH_SUPPORTED_SCOPES).length > 0
        ? splitList(env.METAMCP_AUTH_SUPPORTED_SCOPES)
        : undefined,
    };
  }

  if (staticToken) {
    return { mode: 'static-token', staticToken, requiredScopes: [] };
  }

  return { mode: 'open', requiredScopes: [] };
}

/** Constant-time comparison, length-safe. */
function secureEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface AuthDecision {
  ok: boolean;
  /** HTTP status to return when `ok` is false. */
  status?: number;
  /** `WWW-Authenticate` value to return when `ok` is false. */
  challenge?: string;
  error?: string;
  errorDescription?: string;
  /** Subject and scopes of an accepted token, in oauth mode. */
  subject?: string;
  scopes?: string[];
}

/**
 * Authorizes one request.
 *
 * A `verifier` is injected rather than constructed here so tests can drive the
 * claim path without a key server, and so the JWKS client is built once per
 * process instead of once per request.
 */
export async function authorizeGatewayRequest(
  config: GatewayAuthConfig,
  headers: { authorization?: string; 'x-metamcp-token'?: string },
  verifier?: TokenVerifier
): Promise<AuthDecision> {
  if (config.mode === 'open') return { ok: true };

  if (config.mode === 'static-token') {
    const supplied = parseStaticCredential(headers);
    // Timing-safe: the previous `===` leaked the shared secret's prefix length
    // to an attacker able to measure response time across many attempts.
    if (supplied !== null && secureEquals(supplied, config.staticToken ?? '')) {
      return { ok: true };
    }
    return {
      ok: false,
      status: 401,
      challenge: bearerChallenge({ error: 'invalid_token' }),
      error: 'unauthorized',
    };
  }

  // oauth mode
  if (!verifier) {
    // Refusing is the safe failure: proceeding without a verifier would accept
    // any syntactically valid token.
    return {
      ok: false,
      status: 500,
      error: 'server_error',
      errorDescription: 'token verifier unavailable',
    };
  }

  const metadataUrl = protectedResourceMetadataUrl(config.resourceUrl as URL);
  try {
    const token = parseBearerToken(headers.authorization);
    const claims = await verifier.verify(token);
    const info = validateTokenClaims(claims, {
      expectedAudience: (config.resourceUrl as URL).href,
      expectedIssuers: config.issuer ? [config.issuer] : undefined,
      requiredScopes: config.requiredScopes,
    });
    return { ok: true, subject: info.subject, scopes: info.scopes };
  } catch (err) {
    const failure =
      err instanceof BearerAuthError
        ? err
        : // A verifier throw is a signature/shape failure, not a server fault.
          new InvalidTokenError(err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      status: failure.status,
      challenge: bearerChallenge({
        error: failure.code,
        errorDescription: failure.message,
        requiredScopes: config.requiredScopes,
        resourceMetadataUrl: metadataUrl,
      }),
      error: failure.code,
      errorDescription: failure.message,
    };
  }
}

/** Accepts the token from either header the gateway has always supported. */
function parseStaticCredential(headers: {
  authorization?: string;
  'x-metamcp-token'?: string;
}): string | null {
  const direct = headers['x-metamcp-token'];
  if (direct) return direct;
  const auth = headers.authorization;
  if (!auth) return null;
  const [scheme, ...rest] = auth.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join('');
  return token.length > 0 ? token : null;
}

/** Build the JWKS verifier for an oauth-mode config. */
export function createGatewayVerifier(config: GatewayAuthConfig): TokenVerifier | undefined {
  if (config.mode !== 'oauth') return undefined;
  return new JwksTokenVerifier({
    jwksUri: config.jwksUri as URL,
    issuer: config.issuer,
    audience: (config.resourceUrl as URL).href,
  });
}

/** Path the metadata document is served at, or null outside oauth mode. */
export function gatewayMetadataPath(config: GatewayAuthConfig): string | null {
  if (config.mode !== 'oauth') return null;
  return protectedResourceMetadataPath(config.resourceUrl as URL);
}

/** The metadata document itself, or null outside oauth mode. */
export function gatewayMetadataDocument(config: GatewayAuthConfig): ProtectedResourceMetadata | null {
  if (config.mode !== 'oauth') return null;
  return buildProtectedResourceMetadata({
    resourceUrl: config.resourceUrl as URL,
    authorizationServers: [config.issuer as string],
    scopesSupported: config.supportedScopes,
    resourceName: 'MetaMCP',
  });
}
