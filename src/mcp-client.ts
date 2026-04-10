import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig, ToolDefinition } from './types.js';
import { FileOAuthProvider } from './oauth-provider.js';
import { log } from './log.js';
import type { ChildProcess } from 'node:child_process';

/**
 * Typed accessor for StdioClientTransport internals.
 * The SDK keeps _process private; we need it for graceful shutdown.
 */
interface TransportInternals {
  _process?: ChildProcess;
}

export class McpClient {
  private client: Client | null = null;
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
        this.authProvider = new FileOAuthProvider(this.config.name);
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
        env: {
          ...process.env,
          ...this.config.env,
        } as Record<string, string>,
      });
    }

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
        throw err;
      }
    }
  }

  /**
   * PID of the child process (null for remote servers).
   */
  get pid(): number | null {
    if (this.isRemote) return null;
    return (this.transport as StdioClientTransport)?.pid ?? null;
  }

  /**
   * Close stdin pipe to child — signals no more input.
   * Returns true if stdin was successfully ended, false if fallback to kill is needed.
   * No-op for remote servers (returns false to skip PID-based shutdown).
   */
  closeStdin(): boolean {
    if (this.isRemote || !this.transport) return false;
    const internals = this.transport as unknown as TransportInternals;
    const proc = internals._process;
    if (!proc?.stdin) return false;
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
    this.transport = null;
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (!this.client) throw new Error(`Not connected to ${this.config.name}`);
    const result = await this.client.listTools();
    return result.tools.map((t: Tool) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      server: this.config.name,
    }));
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client) throw new Error(`Not connected to ${this.config.name}`);
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: this.config.timeoutMs ?? 60_000 },
    );
    return result as CallToolResult;
  }

  async disconnect(): Promise<void> {
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
  }

  get isConnected(): boolean {
    return this.client !== null;
  }
}
