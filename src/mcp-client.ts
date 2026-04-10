import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig, ToolDefinition } from './types.js';
import type { ElicitationRequest, ElicitationResponse } from './elicitation.js';
import type { ChildProcess } from 'node:child_process';

/**
 * Typed accessor for StdioClientTransport internals.
 * The SDK keeps _process private; we need it for graceful shutdown.
 */
interface TransportInternals {
  _process?: ChildProcess;
}

export type ElicitationCallback = (server: string, request: ElicitationRequest) => Promise<ElicitationResponse>;

export class McpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  readonly config: ServerConfig;
  private elicitationCallback: ElicitationCallback | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  /** True if this client connects to a remote server (no local PID). */
  get isRemote(): boolean {
    return false; // Open-source extraction: stdio only
  }

  onElicitation(callback: ElicitationCallback): void {
    this.elicitationCallback = callback;
  }

  async connect(): Promise<void> {
    let command: string;
    let args: string[];
    let env: Record<string, string>;

    if (this.config.sandbox) {
      // Spawn inside mentu-runtime VM
      command = 'mentu-runtime';
      args = [
        'exec',
        '--profile', this.config.sandbox,
        '--',
        this.config.command,
        ...(this.config.args ?? []),
      ];
      env = { ...process.env } as Record<string, string>;
    } else {
      // Spawn as local process (existing behavior)
      command = this.config.command;
      args = this.config.args ?? [];
      env = {
        ...process.env,
        ...this.config.env,
      } as Record<string, string>;
    }

    this.transport = new StdioClientTransport({ command, args, env });

    this.client = new Client({
      name: 'metamcp',
      version: '1.0.0',
    });

    // Register elicitation handler before connecting.
    // MCP servers may send elicitation requests as server-initiated
    // notifications. We use the fallback handler to catch elicitation
    // notifications since the SDK doesn't have a built-in schema for them.
    if (this.elicitationCallback) {
      const callback = this.elicitationCallback;
      const serverName = this.config.name;
      this.client.fallbackNotificationHandler = async (notification) => {
        if (notification.method === 'elicitation/request') {
          const params = notification.params as unknown as ElicitationRequest;
          await callback(serverName, params);
        }
      };
    }

    await this.client.connect(this.transport);
  }

  /**
   * PID of the child process.
   * Uses public transport.pid getter (available since SDK v1.27.1).
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
