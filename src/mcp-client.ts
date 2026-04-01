import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig, ToolDefinition } from './types.js';
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
  private transport: StdioClientTransport | null = null;
  readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    let command: string;
    let args: string[];
    let env: Record<string, string>;

    command = this.config.command;
    args = this.config.args ?? [];
    env = {
      ...process.env,
      ...this.config.env,
    } as Record<string, string>;

    this.transport = new StdioClientTransport({ command, args, env });

    this.client = new Client({
      name: 'metamcp',
      version: '1.0.0',
    });

    await this.client.connect(this.transport);
  }

  /**
   * PID of the child process (from transport).
   */
  get pid(): number | null {
    return this.transport?.pid ?? null;
  }

  /**
   * Close stdin pipe to child — signals no more input.
   * Returns true if stdin was successfully ended, false if fallback to kill is needed.
   */
  closeStdin(): boolean {
    if (!this.transport) return false;
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
    const result = await this.client.callTool({ name, arguments: args });
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
