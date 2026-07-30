/**
 * File-based OAuth client provider for MetaMCP.
 *
 * Implements the MCP SDK's OAuthClientProvider interface with persistent
 * token storage at ~/.metamcp/oauth/<server>/. The SDK handles the full
 * OAuth 2.0 flow - this provider supplies storage and browser redirect.
 *
 * First run: opens browser for user consent, receives callback, stores tokens.
 * Subsequent runs: loads persisted tokens, SDK auto-refreshes if expired.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { LoopbackCallbackServer, generateState, stepUpScope, type AuthChallenge } from './oauth-hardening.js';

export interface OAuthProviderOptions {
  /**
   * HTTPS URL of a Client ID Metadata Document. When the authorization server
   * advertises `client_id_metadata_document_supported`, the SDK uses this as
   * the client_id instead of registering dynamically — Dynamic Client
   * Registration is deprecated as of MCP 2026-07-28.
   */
  clientMetadataUrl?: string;
  /** Space-delimited scopes to request. Omitted entirely when unset. */
  scope?: string;
}

export class FileOAuthProvider implements OAuthClientProvider {
  private readonly dir: string;
  private callback: LoopbackCallbackServer | null = null;
  readonly clientMetadataUrl?: string;
  /** Widened by step-up; persisted so it survives a reconnect. */
  private scope?: string;

  constructor(private readonly serverName: string, options: OAuthProviderOptions = {}) {
    this.dir = join(homedir(), '.metamcp', 'oauth', serverName);
    mkdirSync(this.dir, { recursive: true });
    this.clientMetadataUrl = options.clientMetadataUrl;
    // A scope granted by an earlier step-up outranks the configured baseline,
    // otherwise every reconnect would drop back and step up again.
    this.scope = this.readText('scope.txt') ?? options.scope;
  }

  /**
   * Bind the loopback redirect listener. Must be awaited before the SDK reads
   * `redirectUrl`, because the port is assigned by the OS rather than fixed.
   */
  async prepare(): Promise<void> {
    if (!this.callback) this.callback = await LoopbackCallbackServer.start();
  }

  /**
   * Release a redirect listener bound by prepare() without completing the
   * flow. Safe to call repeatedly; leaving one bound keeps the process alive.
   */
  dispose(): void {
    this.callback?.close();
    this.callback = null;
  }

  /** Scope currently requested at authorization time. */
  get requestedScope(): string | undefined {
    return this.scope;
  }

  /**
   * Handle an `insufficient_scope` challenge by widening the requested scope to
   * the union of what we hold and what the server demanded, and dropping the
   * current tokens so the next connect re-authorizes.
   *
   * Returns the new scope, or null when no step-up applies — the caller should
   * surface the original error rather than retry, since re-authorizing with an
   * unchanged scope would loop.
   */
  async stepUp(challenge: AuthChallenge): Promise<string | null> {
    const widened = stepUpScope(this.scope, challenge);
    if (widened === null) return null;
    this.scope = widened;
    writeFileSync(join(this.dir, 'scope.txt'), widened, { mode: 0o600 });
    // The held token cannot gain a scope; force a fresh authorization.
    await this.invalidateCredentials('tokens');
    return widened;
  }

  get redirectUrl(): string {
    if (!this.callback) {
      throw new Error(`OAuth callback listener not started for ${this.serverName} — call prepare() first`);
    }
    return this.callback.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'metamcp',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  /**
   * CSRF state, persisted so the authorization response can be checked against
   * the request that caused it. The SDK omits `state` entirely when a provider
   * does not implement this.
   */
  async state(): Promise<string> {
    const value = generateState();
    writeFileSync(join(this.dir, 'state.txt'), value, { mode: 0o600 });
    return value;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.readJson<OAuthClientInformationMixed>('client-info.json');
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.writeJson('client-info.json', info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.readJson<OAuthTokens>('tokens.json');
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.writeJson('tokens.json', tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const url = authorizationUrl.toString();

    try {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } catch {
      process.stderr.write(`\n[MetaMCP] Open this URL to authorize ${this.serverName}:\n  ${url}\n\n`);
    }
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    writeFileSync(join(this.dir, 'verifier.txt'), codeVerifier, { mode: 0o600 });
  }

  async codeVerifier(): Promise<string> {
    try {
      return readFileSync(join(this.dir, 'verifier.txt'), 'utf-8').trim();
    } catch {
      throw new Error(`No code verifier saved for ${this.serverName}`);
    }
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const targets: Record<string, string[]> = {
      all: ['tokens.json', 'client-info.json', 'verifier.txt', 'state.txt', 'issuer.txt', 'scope.txt'],
      client: ['client-info.json'],
      tokens: ['tokens.json'],
      verifier: ['verifier.txt'],
      // The pinned issuer is discovery state — re-pinned on the next flow.
      discovery: ['issuer.txt'],
    };
    for (const file of targets[scope] ?? []) {
      const path = join(this.dir, file);
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  }

  /**
   * Await the authorization callback and return the code.
   *
   * The response is rejected unless it echoes the `state` we sent (CSRF) and,
   * when the authorization server identifies itself, carries the `iss` we
   * pinned on the first successful authorization (RFC 9207).
   */
  async waitForCallback(): Promise<string> {
    if (!this.callback) {
      throw new Error(`OAuth callback listener not started for ${this.serverName} — call prepare() first`);
    }
    try {
      const { code, iss } = await this.callback.waitForCode({
        expectedState: this.readText('state.txt'),
        expectedIssuer: this.readText('issuer.txt'),
      });
      // Pin the issuer on first use so later flows are checked against it.
      if (iss && !this.readText('issuer.txt')) {
        writeFileSync(join(this.dir, 'issuer.txt'), iss, { mode: 0o600 });
      }
      return code;
    } finally {
      this.callback = null;
      try { unlinkSync(join(this.dir, 'state.txt')); } catch { /* already gone */ }
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private readText(filename: string): string | undefined {
    try {
      const value = readFileSync(join(this.dir, filename), 'utf-8').trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private readJson<T>(filename: string): T | undefined {
    const path = join(this.dir, filename);
    try {
      if (!existsSync(path)) return undefined;
      return JSON.parse(readFileSync(path, 'utf-8')) as T;
    } catch {
      return undefined;
    }
  }

  private writeJson(filename: string, data: unknown): void {
    const path = join(this.dir, filename);
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}
