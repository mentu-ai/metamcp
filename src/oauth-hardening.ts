/**
 * OAuth client hardening (MCP 2026-07-28 authorization requirements).
 *
 * The 2026-07-28 spec aligns MCP authorization with production OAuth 2.0 /
 * OIDC deployments. Three of its requirements were not met by the previous
 * setup, and none of them are supplied by SDK 1.x:
 *
 *   - **CSRF `state`.** The SDK sends a `state` parameter only when the
 *     provider implements `state()`. Ours did not, so authorization responses
 *     were accepted without any binding to the request that caused them.
 *   - **RFC 9207 `iss` validation.** An authorization server that supports
 *     issuer identification returns `iss` on the callback; a client must check
 *     it to detect mix-up attacks. SDK 1.x has no issuer validation at all.
 *   - **A fixed callback port.** Binding 19890 meant exactly one OAuth flow
 *     could run per machine, so a second server's authorization failed with an
 *     opaque EADDRINUSE.
 *
 * RFC 8707 resource indicators and CIMD (SEP-991 URL-based client IDs) are
 * already implemented inside SDK 1.x; they need configuration, not code, and
 * are wired through the providers rather than here.
 */

import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export const CALLBACK_TIMEOUT_MS = 120_000;

/** Raw authorization-response parameters captured from the loopback callback. */
export interface CallbackParams {
  code: string;
  state: string | null;
  /** RFC 9207 issuer identifier, when the authorization server sends one. */
  iss: string | null;
}

export interface CallbackExpectations {
  /** The `state` we sent; the response must echo it exactly. */
  expectedState?: string;
  /**
   * Issuer we expect. When omitted and the response carries `iss`, the caller
   * is told the observed issuer so it can be pinned for subsequent flows.
   */
  expectedIssuer?: string;
  timeoutMs?: number;
}

export class OAuthCallbackError extends Error {}

/** Cryptographically random, URL-safe CSRF state. */
export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time string comparison, length-safe. */
export function secureEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * RFC 9207 §2.4: if the authorization response carries `iss`, it must identify
 * the authorization server the request was sent to. A mismatch means the
 * response came from somewhere else and the code must not be redeemed.
 *
 * Comparison is on the exact issuer string, as RFC 8414 requires issuers to be
 * byte-identical rather than URL-normalised.
 */
export function assertIssuer(received: string | null, expected: string | undefined): void {
  if (received === null || expected === undefined) return;
  if (received !== expected) {
    throw new OAuthCallbackError(
      `Authorization response issuer mismatch (RFC 9207): expected ${expected}, got ${received}`
    );
  }
}

/** Validate a captured authorization response before its code may be redeemed. */
export function validateCallback(params: CallbackParams, expect: CallbackExpectations): void {
  if (expect.expectedState !== undefined) {
    if (params.state === null) {
      throw new OAuthCallbackError('Authorization response is missing the state parameter');
    }
    if (!secureEquals(params.state, expect.expectedState)) {
      throw new OAuthCallbackError('Authorization response state mismatch — possible CSRF');
    }
  }
  assertIssuer(params.iss, expect.expectedIssuer);
}

// ─── Step-up authorization (insufficient_scope) ─────────────────────────────

/**
 * Split an OAuth scope string. Scopes are space-delimited per RFC 6749 §3.3,
 * but tolerate any run of whitespace.
 */
export function parseScopes(scope: string | undefined): string[] {
  if (!scope) return [];
  return scope.trim().split(/\s+/).filter((s) => s.length > 0);
}

export function formatScopes(scopes: readonly string[]): string {
  return scopes.join(' ');
}

/**
 * Union of granted and newly-required scopes, preserving first-seen order.
 *
 * A step-up must be additive: re-authorizing with only the newly demanded
 * scope would silently drop everything already granted, so the next call that
 * needed an older scope would fail and step up again — an authorization loop.
 */
export function computeScopeUnion(
  current: string | undefined,
  required: string | undefined
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...parseScopes(current), ...parseScopes(required)]) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return formatScopes(out);
}

/** True when `a` contains every scope in `b` (and so needs no step-up). */
export function isScopeSuperset(a: string | undefined, b: string | undefined): boolean {
  const have = new Set(parseScopes(a));
  return parseScopes(b).every((s) => have.has(s));
}

/**
 * A parsed `WWW-Authenticate` challenge, as returned by the SDK's
 * `extractWWWAuthenticateParams`.
 */
export interface AuthChallenge {
  error?: string;
  scope?: string;
}

/**
 * Whether a challenge asks for a step-up: the token was accepted as valid but
 * lacks a scope the operation needs (RFC 6750 §3.1 `insufficient_scope`).
 */
export function isInsufficientScope(challenge: AuthChallenge | undefined): boolean {
  return challenge?.error === 'insufficient_scope';
}

/**
 * Decide the scope to request after a challenge.
 *
 * Returns null when no step-up is warranted — either the challenge is about
 * something else, or the scope it names is already covered, in which case
 * re-authorizing would not change the outcome and would loop.
 */
export function stepUpScope(
  currentScope: string | undefined,
  challenge: AuthChallenge | undefined
): string | null {
  if (!isInsufficientScope(challenge) || !challenge?.scope) return null;
  if (isScopeSuperset(currentScope, challenge.scope)) return null;
  return computeScopeUnion(currentScope, challenge.scope);
}

const PAGE_OK =
  '<html><body><h1>Authorized</h1><p>You can close this tab.</p>' +
  '<script>setTimeout(()=>window.close(),2000)</script></body></html>';

/**
 * Loopback redirect listener bound to an ephemeral port.
 *
 * Start it *before* the authorization URL is built, so `redirectUrl` names the
 * port that is actually listening. The captured response is validated in
 * {@link waitForCode} rather than in the request handler, so a hostile caller
 * cannot learn from the browser response whether its guess of `state` was
 * right — the page renders the same either way.
 */
export class LoopbackCallbackServer {
  private captured: Promise<CallbackParams>;
  private closed = false;

  private constructor(
    private readonly server: Server,
    readonly port: number,
    capture: Promise<CallbackParams>
  ) {
    this.captured = capture;
  }

  static async start(): Promise<LoopbackCallbackServer> {
    let resolveParams!: (p: CallbackParams) => void;
    let rejectParams!: (e: Error) => void;
    const capture = new Promise<CallbackParams>((res, rej) => {
      resolveParams = res;
      rejectParams = rej;
    });
    // Nothing awaits `capture` until waitForCode(); without a no-op catch an
    // early rejection would surface as an unhandled rejection.
    capture.catch(() => {});

    const server = createServer((req, res) => {
      if (!req.url || req.url === '/favicon.ico') {
        res.writeHead(404);
        res.end();
        return;
      }
      const parsed = new URL(req.url, 'http://127.0.0.1');
      const code = parsed.searchParams.get('code');
      const error = parsed.searchParams.get('error');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(PAGE_OK);
        resolveParams({
          code,
          state: parsed.searchParams.get('state'),
          iss: parsed.searchParams.get('iss'),
        });
      } else {
        const msg = error ?? 'No authorization code in callback';
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Error</h1><p>${msg}</p></body></html>`);
        rejectParams(new OAuthCallbackError(`OAuth callback error: ${msg}`));
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Port 0 → the OS assigns a free port, so concurrent authorizations on
      // one machine no longer collide.
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const port = (server.address() as AddressInfo).port;
    return new LoopbackCallbackServer(server, port, capture);
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  /**
   * Await the authorization response, validate it, and return the code.
   * Always closes the listener.
   */
  async waitForCode(expect: CallbackExpectations = {}): Promise<{ code: string; iss: string | null }> {
    const timeoutMs = expect.timeoutMs ?? CALLBACK_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new OAuthCallbackError(`OAuth authorization timed out after ${timeoutMs / 1000}s`)),
        timeoutMs
      );
    });

    try {
      const params = await Promise.race([this.captured, timeout]);
      validateCallback(params, expect);
      return { code: params.code, iss: params.iss };
    } finally {
      if (timer) clearTimeout(timer);
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.close();
  }
}
