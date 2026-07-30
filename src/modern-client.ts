/**
 * Modern-era outbound MCP (client side of MCP 2026-07-28).
 *
 * `dual-era.ts` made this gateway *serve* both protocol eras. This module is
 * the other direction: talking to child servers in the modern era when they
 * support it, instead of always using the legacy `initialize` handshake.
 *
 * ## Why not just use the SDK
 *
 * The era must be decided *before* the first request. Per spec an `initialize`
 * request selects legacy semantics, and SDK 1.x's `Client.connect()` always
 * sends one — so by the time an SDK client is usable, the connection is already
 * committed to the legacy era. There is no SDK 1.x hook to probe first.
 *
 * So the flow is: start the transport ourselves, ask `server/discover`, and
 * only then decide. A modern child is driven directly by {@link ModernMcpSession}
 * (raw JSON-RPC with per-request `_meta`, no handshake). A legacy child is
 * handed to the ordinary SDK `Client`, which is why {@link PreStartedTransport}
 * exists — the transport is already running by then, and the SDK would
 * otherwise throw on a second `start()`.
 *
 * Nothing here changes legacy behaviour: a child that answers
 * `server/discover` with MethodNotFound follows exactly the path it did before.
 */

import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo, RequestId } from '@modelcontextprotocol/sdk/types.js';
import {
  FIRST_MODERN_PROTOCOL_VERSION,
  isModernProtocolVersion,
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
} from './dual-era.js';

/** JSON-RPC MethodNotFound — a legacy server's answer to `server/discover`. */
const METHOD_NOT_FOUND = -32601;

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export type ChildEra = 'modern' | 'legacy';

export interface ClientInfo {
  name: string;
  version: string;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class ModernRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = 'ModernRequestError';
  }
}

/**
 * The server answered `resultType: "input_required"` — an MRTR round-trip.
 *
 * Surfaced rather than answered: satisfying it means eliciting from the user,
 * which is the host's decision, not something this transport layer may invent.
 * The payload is carried so a caller that *can* answer has what it needs.
 */
export class InputRequiredError extends Error {
  constructor(
    readonly method: string,
    readonly result: Record<string, unknown>
  ) {
    super(`Server requires further input for ${method}`);
    this.name = 'InputRequiredError';
  }
}

// ─── Pre-started transport wrapper ──────────────────────────────────────────

/**
 * Wraps a transport whose `start()` has already been called, so it can still be
 * handed to an SDK `Client`.
 *
 * `Protocol.connect()` calls `transport.start()`, and the SDK's stdio transport
 * throws if it is started twice ("already started"). Since the era probe has to
 * run before any handshake, the transport is necessarily live by then; this
 * makes the second `start()` a no-op instead of a crash.
 *
 * Messages that arrive between the probe finishing and the `Client` attaching
 * are buffered and replayed, so nothing is dropped in the handover window.
 */
export class PreStartedTransport implements Transport {
  private innerStarted = false;
  private buffered: Array<{ message: JSONRPCMessage; extra?: MessageExtraInfo }> = [];
  private downstream?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  sessionId?: string;

  constructor(private readonly inner: Transport) {
    this.inner.onmessage = (message, extra) => this.receive(message, extra);
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (err) => this.onerror?.(err);
  }

  /** Install the handler; anything buffered so far is replayed immediately. */
  set onmessage(handler: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined) {
    this.downstream = handler;
    if (handler && this.buffered.length > 0) {
      const pending = this.buffered;
      this.buffered = [];
      for (const { message, extra } of pending) handler(message, extra);
    }
  }

  get onmessage(): (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined {
    return this.downstream;
  }

  private receive(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    if (this.downstream) this.downstream(message, extra);
    else this.buffered.push({ message, extra });
  }

  /** Start the inner transport once; later calls resolve without re-starting. */
  async start(): Promise<void> {
    if (this.innerStarted) return;
    this.innerStarted = true;
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  /** The wrapped transport, for callers that need its concrete type. */
  get wrapped(): Transport {
    return this.inner;
  }

  /**
   * Process lifecycle passthroughs. Child shutdown reads `pid` and the stdio
   * transport's private `_process` off whatever object it holds; once that
   * object is this wrapper, those lookups would come back empty and every child
   * would be killed by signal instead of shut down gracefully. Forwarding keeps
   * existing call sites correct without teaching each of them about the wrapper.
   */
  get pid(): number | null {
    return (this.inner as { pid?: number | null }).pid ?? null;
  }

  get _process(): unknown {
    return (this.inner as { _process?: unknown })._process;
  }

  get stderr(): unknown {
    return (this.inner as { stderr?: unknown }).stderr;
  }
}

/** Unwrap a {@link PreStartedTransport}, or return the transport unchanged. */
export function unwrapTransport(transport: unknown): unknown {
  return transport instanceof PreStartedTransport ? transport.wrapped : transport;
}

// ─── Raw request/response over a transport ──────────────────────────────────

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal JSON-RPC client over a `Transport`, used for the era probe and for
 * modern-era traffic. Deliberately not a general MCP client: it has no
 * handshake, no capability negotiation and no notification routing, because the
 * modern era needs none of those to issue a request.
 */
class RawJsonRpc {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly transport: Transport) {
    const previous = transport.onmessage;
    transport.onmessage = (message, extra) => {
      previous?.(message, extra);
      this.handle(message);
    };
  }

  private handle(message: JSONRPCMessage): void {
    const id = (message as { id?: RequestId }).id;
    if (id === undefined || id === null) return; // notification
    const waiter = this.pending.get(String(id));
    if (!waiter) return;
    this.pending.delete(String(id));
    clearTimeout(waiter.timer);

    const error = (message as { error?: { code: number; message: string; data?: unknown } }).error;
    if (error) {
      waiter.reject(new ModernRequestError(error.code, error.message, error.data));
      return;
    }
    waiter.resolve(((message as { result?: Record<string, unknown> }).result ?? {}));
  }

  async request(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error(`Cannot send ${method}: session closed`);
    const id = this.nextId++;
    const key = String(id);

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer });

      this.transport
        .send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } as unknown as JSONRPCMessage)
        .catch((err: unknown) => {
          this.pending.delete(key);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  /** Fail every in-flight request; called when the session is torn down. */
  dispose(reason: string): void {
    this.closed = true;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

// ─── Era probe ──────────────────────────────────────────────────────────────

export interface EraProbe {
  era: ChildEra;
  /** Modern revisions the child advertises, when modern. */
  supportedVersions?: string[];
  capabilities?: Record<string, unknown>;
  /** Why we fell back to legacy, when the reason is not MethodNotFound. */
  reason?: string;
}

/**
 * Decide a child's era by asking `server/discover` before any handshake.
 *
 * Always resolves. Anything other than a usable modern answer resolves to
 * `legacy`, because the legacy path is the one that already works — a probe
 * failure must never turn a reachable child into an unreachable one.
 *
 * The transport must already be started (see {@link PreStartedTransport}).
 */
export async function probeChildEra(
  transport: Transport,
  options: { timeoutMs?: number } = {}
): Promise<EraProbe> {
  const rpc = new RawJsonRpc(transport);
  try {
    const result = await rpc.request('server/discover', undefined, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    const versions = Array.isArray(result.supportedVersions)
      ? (result.supportedVersions as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    const modern = versions.filter(isModernProtocolVersion);
    if (modern.length === 0) {
      return {
        era: 'legacy',
        supportedVersions: versions,
        reason: `no modern revision advertised (need >= ${FIRST_MODERN_PROTOCOL_VERSION})`,
      };
    }
    const capabilities =
      typeof result.capabilities === 'object' && result.capabilities !== null
        ? (result.capabilities as Record<string, unknown>)
        : undefined;
    return { era: 'modern', supportedVersions: modern, capabilities };
  } catch (err) {
    if (err instanceof ModernRequestError && err.code === METHOD_NOT_FOUND) {
      // The expected, healthy answer from a legacy server.
      return { era: 'legacy' };
    }
    return {
      era: 'legacy',
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    rpc.dispose('era probe complete');
  }
}

// ─── Modern session ─────────────────────────────────────────────────────────

export interface ToolSummary {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ModernSessionOptions {
  clientInfo: ClientInfo;
  /** Capabilities advertised on every request, as the modern era requires. */
  clientCapabilities?: Record<string, unknown>;
  protocolVersion?: string;
  requestTimeoutMs?: number;
}

/**
 * A modern-era conversation with one child server.
 *
 * Every request carries the `_meta` fields the stateless core requires; there
 * is no handshake and no session identifier, which is the point of the era —
 * the server may serve each request independently.
 */
export class ModernMcpSession {
  private readonly rpc: RawJsonRpc;
  private readonly protocolVersion: string;
  private readonly clientCapabilities: Record<string, unknown>;

  constructor(
    private readonly transport: Transport,
    private readonly options: ModernSessionOptions
  ) {
    this.rpc = new RawJsonRpc(transport);
    this.protocolVersion = options.protocolVersion ?? FIRST_MODERN_PROTOCOL_VERSION;
    this.clientCapabilities = options.clientCapabilities ?? {};
  }

  /** `_meta` block attached to every modern request. */
  private meta(): Record<string, unknown> {
    return {
      [PROTOCOL_VERSION_META_KEY]: this.protocolVersion,
      [CLIENT_CAPABILITIES_META_KEY]: this.clientCapabilities,
      [CLIENT_INFO_META_KEY]: this.options.clientInfo,
    };
  }

  /**
   * Issue a modern request and unwrap the result envelope.
   *
   * `resultType: "input_required"` is raised as {@link InputRequiredError}
   * rather than returned, so a caller cannot mistake a half-finished
   * round-trip for a completed one.
   */
  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<Record<string, unknown>> {
    const result = await this.rpc.request(
      method,
      { ...params, _meta: { ...(params._meta as Record<string, unknown> | undefined), ...this.meta() } },
      timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    );

    if (result.resultType === 'input_required') {
      throw new InputRequiredError(method, result);
    }
    return result;
  }

  async listTools(): Promise<ToolSummary[]> {
    const result = await this.request('tools/list');
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools.map((t) => {
      const tool = t as { name: string; description?: string; inputSchema?: Record<string, unknown> };
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
    });
  }

  async callTool(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.request('tools/call', { name, ...(args ? { arguments: args } : {}) }, timeoutMs);
  }

  async close(): Promise<void> {
    this.rpc.dispose('session closed');
    await this.transport.close();
  }
}
