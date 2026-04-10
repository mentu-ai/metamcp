/**
 * File-based OAuth client provider for MetaMCP.
 *
 * Implements the MCP SDK's OAuthClientProvider interface with persistent
 * token storage at ~/.metamcp/oauth/<server>/. The SDK handles the full
 * OAuth 2.0 flow — this provider supplies storage and browser redirect.
 *
 * First run: opens browser for user consent, receives callback, stores tokens.
 * Subsequent runs: loads persisted tokens, SDK auto-refreshes if expired.
 */

import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const CALLBACK_PORT = 19890;
const CALLBACK_TIMEOUT_MS = 120_000;

export class FileOAuthProvider implements OAuthClientProvider {
  private readonly dir: string;
  private callbackResolve: ((code: string) => void) | null = null;

  constructor(private readonly serverName: string) {
    this.dir = join(homedir(), '.metamcp', 'oauth', serverName);
    mkdirSync(this.dir, { recursive: true });
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${CALLBACK_PORT}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'metamcp',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    };
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
      all: ['tokens.json', 'client-info.json', 'verifier.txt'],
      client: ['client-info.json'],
      tokens: ['tokens.json'],
      verifier: ['verifier.txt'],
      discovery: [],
    };
    for (const file of targets[scope] ?? []) {
      const path = join(this.dir, file);
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  }

  /**
   * Start an ephemeral HTTP server to receive the OAuth callback.
   * Resolves with the authorization code. Times out after 120s.
   */
  waitForCallback(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.callbackResolve = resolve;
      const server = createServer((req, res) => {
        if (!req.url || req.url === '/favicon.ico') {
          res.writeHead(404);
          res.end();
          return;
        }

        const parsed = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
        const code = parsed.searchParams.get('code');
        const error = parsed.searchParams.get('error');

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authorized</h1><p>You can close this tab.</p><script>setTimeout(()=>window.close(),2000)</script></body></html>');
          this.callbackResolve = null;
          setTimeout(() => server.close(), 1000);
          resolve(code);
        } else {
          const msg = error ?? 'No authorization code in callback';
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>Error</h1><p>${msg}</p></body></html>`);
          this.callbackResolve = null;
          setTimeout(() => server.close(), 1000);
          reject(new Error(`OAuth callback error: ${msg}`));
        }
      });

      server.listen(CALLBACK_PORT, '127.0.0.1');

      server.on('error', (err) => {
        reject(new Error(`OAuth callback server error: ${err.message}`));
      });

      setTimeout(() => {
        if (this.callbackResolve) {
          this.callbackResolve = null;
          server.close();
          reject(new Error(`OAuth authorization timed out after ${CALLBACK_TIMEOUT_MS / 1000}s for ${this.serverName}`));
        }
      }, CALLBACK_TIMEOUT_MS);
    });
  }

  // ─── Internal ────────────────────────────────────────────────────────────

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
