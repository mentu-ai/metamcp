import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ChildCallOptions, ServerConfig, ToolDefinition } from './types.js';
import { FileOAuthProvider } from './oauth-provider.js';
import {
  PreStartedTransport,
  probeChildEra,
  ModernMcpSession,
  type ChildEra,
} from './modern-client.js';
import { log } from './log.js';
import type { ChildProcess } from 'node:child_process';

/**
 * Typed accessor for StdioClientTransport internals.
 * The SDK keeps _process private; we need it for graceful shutdown.
 */
interface TransportInternals {
  _process?: ChildProcess;
}

/**
 * Resolve the child process behind a StdioClientTransport.
 *
 * The SDK exposes only `pid` and `stderr` publicly — there is no supported way
 * to end the child's stdin, so we reach for the private `_process`. That field
 * is an SDK internal: if a future release renames it this returns null and the
 * caller falls back to signals. Renames are caught by the shape guard in
 * __tests__/sdk-internals.test.ts rather than degrading silently in production.
 */
export function resolveChildProcess(transport: unknown): ChildProcess | null {
  const proc = (transport as TransportInternals | null)?._process;
  return proc ?? null;
}

/**
 * Probe budget. A legacy child answers MethodNotFound immediately, so this only
 * bounds a child that ignores unknown methods entirely — keep it short so such
 * a child costs a moment, not a stall, on every connect.
 */
const ERA_PROBE_TIMEOUT_MS = 3000;

const SAFE_INHERITED_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP',
  'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'ComSpec', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
] as const;

/** Build a minimal child environment instead of leaking the gateway's secrets. */
export function buildChildEnvironment(
  config: Pick<ServerConfig, 'env' | 'inheritEnv'>,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const names = new Set<string>([...SAFE_INHERITED_ENV, ...(config.inheritEnv ?? [])]);
  const childEnv: Record<string, string> = {};
  for (const name of names) {
    const value = parent[name];
    if (value !== undefined) childEnv[name] = value;
  }
  return { ...childEnv, ...(config.env ?? {}) };
}

export class McpClient {
  private client: Client | null = null;
  /** Set when the child speaks MCP 2026-07-28; `client` stays null then. */
  private modern: ModernMcpSession | null = null;
  private era: ChildEra = 'legacy';
  private transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport | null = null;
  readonly config: ServerConfig;
  private authProvider: FileOAuthProvider | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  /** True if this client connects to a remote server (no local PID). */
  get isRemote(): boolean {
    return this.config.transport === 'http' || this.config.transport === 'sse';
  }

  async connect(): Promise<void> {
    if (this.config.transport === 'http' && this.config.url) {
      // Remote HTTP (Streamable HTTP) transport
      if (this.config.oauth) {
        this.authProvider = new FileOAuthProvider(this.config.name, {
          clientMetadataUrl: this.config.oauthClientMetadataUrl,
          scope: this.config.oauthScope,
        });
        // Binds the loopback redirect listener on an OS-assigned port. Must
        // happen before connect(), which reads redirectUrl to build the
        // authorization URL.
        await this.authProvider.prepare();
        this.transport = new StreamableHTTPClientTransport(
          new URL(this.config.url),
          { authProvider: this.authProvider }
        );
      } else {
        this.transport = new StreamableHTTPClientTransport(
          new URL(this.config.url),
          { requestInit: { headers: this.config.headers ?? {} } }
        );
      }
    } else if (this.config.transport === 'sse' && this.config.url) {
      // Remote SSE transport
      this.transport = new SSEClientTransport(
        new URL(this.config.url),
        { requestInit: { headers: this.config.headers ?? {} } }
      );
    } else {
      // Local stdio transport (default)
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: buildChildEnvironment(this.config),
      });
    }

    // Decide the protocol era before any handshake. `initialize` selects the
    // legacy era per spec, so the probe has to come first; PreStartedTransport
    // keeps the already-running transport reusable by the SDK client below.
    const framed = new PreStartedTransport(this.transport);
    await framed.start();
    const probe = await probeChildEra(framed, { timeoutMs: ERA_PROBE_TIMEOUT_MS });
    this.era = probe.era;

    if (probe.era === 'modern') {
      log('info', 'child speaks the modern era', {
        server: this.config.name,
        versions: probe.supportedVersions,
      });
      this.modern = new ModernMcpSession(framed, {
        clientInfo: { name: 'metamcp', version: '1.0.0' },
      });
      this.transport = framed as unknown as typeof this.transport;
      this.authProvider?.dispose();
      return;
    }

    // Logged unconditionally: a clean MethodNotFound carries no `reason`, and
    // leaving that case silent made it impossible to tell "negotiated legacy"
    // apart from "never connected" when reading a live gateway's output.
    log('info', 'child using the legacy era', {
      server: this.config.name,
      ...(probe.reason ? { reason: probe.reason } : {}),
    });
    this.transport = framed as unknown as typeof this.transport;

    this.client = new Client({
      name: 'metamcp',
      version: '1.0.0',
    });

    try {
      await this.client.connect(this.transport);
    } catch (err) {
      if (err instanceof UnauthorizedError && this.authProvider) {
        log('info', 'oauth authorization required, waiting for browser callback', { server: this.config.name });
        const code = await this.authProvider.waitForCallback();
        await (this.transport as StreamableHTTPClientTransport).finishAuth(code);
        // Reconnect with fresh client after auth
        this.client = new Client({ name: 'metamcp', version: '1.0.0' });
        await this.client.connect(this.transport);
      } else {
        // Not an auth failure — release any bound redirect listener so a failed
        // connect cannot leave a socket holding the process open.
        this.authProvider?.dispose();
        throw err;
      }
    }

    // Connected. If the authorization flow ran, waitForCallback() already
    // released the redirect listener; if cached tokens were enough, it was
    // never used — release it either way (dispose is idempotent) so every
    // successful OAuth connect doesn't leave a loopback socket open.
    this.authProvider?.dispose();
  }

  /**
   * PID of the child process (null for remote servers).
   */
  get pid(): number | null {
    if (this.isRemote) return null;
    return (this.transport as StdioClientTransport)?.pid ?? null;
  }

  /**
   * Close stdin pipe to child - signals no more input.
   * Returns true if stdin was successfully ended, false if fallback to kill is needed.
   * No-op for remote servers (returns false to skip PID-based shutdown).
   */
  closeStdin(): boolean {
    if (this.isRemote || !this.transport) return false;
    const proc = resolveChildProcess(this.transport);
    if (!proc) {
      log('warn', 'stdio transport internals unavailable — falling back to signal shutdown', {
        server: this.config.name,
      });
      return false;
    }
    if (!proc.stdin) return false;
    try {
      proc.stdin.end();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Detach from client/transport without triggering the SDK's built-in
   * shutdown sequence (which has its own 2s+2s SIGTERM/SIGKILL logic).
   * Used by ChildManager.shutdown() which implements the escalating signal pattern.
   */
  detach(): void {
    this.client = null;
    this.modern = null;
    this.transport = null;
  }

  /** Protocol era negotiated with this child. */
  get protocolEra(): ChildEra {
    return this.era;
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (this.modern) {
      const tools = await this.modern.listTools();
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
        server: this.config.name,
      }));
    }
    if (!this.client) throw new Error(`Not connected to ${this.config.name}`);
    const result = await this.client.listTools();
    return result.tools.map((t: Tool) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      server: this.config.name,
    }));
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
    options: ChildCallOptions = {},
  ): Promise<CallToolResult> {
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.config.timeoutMs ?? 60_000);
    if (this.modern) {
      const result = await this.modern.callTool(name, args, timeoutMs);
      return result as unknown as CallToolResult;
    }
    if (!this.client) throw new Error(`Not connected to ${this.config.name}`);
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutMs },
    );
    return result as CallToolResult;
  }

  async disconnect(): Promise<void> {
    if (this.modern) {
      try {
        await this.modern.close();
      } catch {
        // ignore close errors
      }
      this.modern = null;
      this.transport = null;
    }
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore close errors
      }
      this.client = null;
    }
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // ignore close errors
      }
      this.transport = null;
    }
    this.authProvider?.dispose();
    this.authProvider = null;
  }

  get isConnected(): boolean {
    return this.client !== null || this.modern !== null;
  }
}
