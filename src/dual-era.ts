/**
 * Dual-era MCP server surface (MCP 2026-07-28).
 *
 * The 2026-07-28 spec replaces the stateful `initialize` handshake with a
 * stateless request/response core: every request carries its own protocol
 * version and client capabilities in `params._meta`, servers answer a
 * `server/discover` RPC instead of `initialize`, and every result carries a
 * `resultType`. The spec explicitly sanctions serving both eras on one
 * endpoint, which is what this module does.
 *
 * Why a wrapper instead of an SDK upgrade: `@modelcontextprotocol/sdk` tops
 * out at 1.30.0 / protocol 2025-11-25 and has no modern-era support at all.
 * The 2026-07-28 era shipped as a separate package family
 * (`@modelcontextprotocol/{core,server,client}@2`) with a different API shape,
 * so adopting it wholesale would mean rewriting every handler in this repo.
 * Instead we keep the 1.x Server for the legacy era and intercept modern
 * traffic at the transport seam, before the 1.x Server ever sees it.
 *
 * Era selection follows the spec: an `initialize` request selects legacy
 * semantics; a request carrying the modern `_meta` protocol fields, or a
 * `server/discover` call, gets stateless handling. Legacy traffic is forwarded
 * untouched, so current Claude Code / Claude.ai clients are unaffected.
 */

import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo, RequestId } from '@modelcontextprotocol/sdk/types.js';

// ─── Modern-era wire constants ──────────────────────────────────────────────

/**
 * The first protocol revision of the modern era. Revision identifiers are ISO
 * dates, so lexicographic comparison orders them chronologically.
 */
export const FIRST_MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * Modern-era revisions we can negotiate via `server/discover`. Deliberately
 * kept separate from the SDK's SUPPORTED_PROTOCOL_VERSIONS (the legacy
 * `initialize` list) so a modern version string can never leak into a
 * 2025-era handshake.
 */
export const SUPPORTED_MODERN_PROTOCOL_VERSIONS: readonly string[] = [FIRST_MODERN_PROTOCOL_VERSION];

export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

/**
 * Error codes added by 2026-07-28. -32020 (HeaderMismatch) is HTTP-only —
 * it reports a mismatch between the Mcp-Method/Mcp-Name routing headers and
 * the body, and cannot arise over stdio — so it is deliberately absent here.
 */
export const ProtocolErrorCode = {
  InvalidParams: -32602,
  MethodNotFound: -32601,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,
} as const;

/** Methods whose modern results carry required cache hints. */
const LIST_METHODS = new Set(['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']);

export function isModernProtocolVersion(version: string): boolean {
  return version >= FIRST_MODERN_PROTOCOL_VERSION;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Implementation {
  name: string;
  version: string;
  title?: string;
  description?: string;
  websiteUrl?: string;
}

export interface DualEraOptions {
  /** Reported in server/discover and stamped onto every modern result. */
  serverInfo: Implementation;
  /** Server capabilities, in the same shape passed to the 1.x Server. */
  capabilities: Record<string, unknown>;
  instructions?: string;
  /**
   * Cache hints stamped onto modern list results. `private` is the safe
   * default: this gateway's tool list is per-installation, not shareable.
   */
  listCache?: { ttlMs: number; cacheScope: 'public' | 'private' };
  /** Optional structured logger; defaults to silent. */
  log?: (level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>) => void;
}

export type Era = 'legacy' | 'modern';

interface JsonRpcRequestLike {
  jsonrpc: '2.0';
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}

const DEFAULT_LIST_CACHE = { ttlMs: 0, cacheScope: 'private' as const };

// ─── Era classification ─────────────────────────────────────────────────────

function isRequest(msg: JSONRPCMessage): msg is JsonRpcRequestLike & JSONRPCMessage {
  return typeof (msg as { method?: unknown }).method === 'string' && 'id' in msg;
}

function metaOf(msg: JsonRpcRequestLike): Record<string, unknown> | undefined {
  const meta = (msg.params as { _meta?: unknown } | undefined)?._meta;
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : undefined;
}

/**
 * Classify an inbound request. Per the spec an `initialize` request selects
 * legacy semantics even if it happens to carry modern `_meta` keys, so that
 * check comes first.
 */
export function classifyEra(msg: JSONRPCMessage): Era {
  if (!isRequest(msg)) return 'legacy';
  if (msg.method === 'initialize') return 'legacy';
  if (msg.method === 'server/discover') return 'modern';
  return metaOf(msg)?.[PROTOCOL_VERSION_META_KEY] !== undefined ? 'modern' : 'legacy';
}

// ─── Modern request validation ──────────────────────────────────────────────

export interface ModernMetaError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Validate the `_meta` fields every modern request must carry.
 *
 * `server/discover` is exempt: it is the call a client makes precisely to
 * learn which versions the server speaks, so it cannot be required to name
 * one first.
 */
export function validateModernMeta(msg: JSONRPCMessage): ModernMetaError | null {
  if (!isRequest(msg) || msg.method === 'server/discover') return null;

  const meta = metaOf(msg);
  const version = meta?.[PROTOCOL_VERSION_META_KEY];

  if (version === undefined) {
    return {
      code: ProtocolErrorCode.InvalidParams,
      message: `Missing required _meta["${PROTOCOL_VERSION_META_KEY}"]`,
    };
  }
  if (typeof version !== 'string' || !SUPPORTED_MODERN_PROTOCOL_VERSIONS.includes(version)) {
    return {
      code: ProtocolErrorCode.UnsupportedProtocolVersion,
      message: `Unsupported protocol version: ${String(version)}`,
      data: { supported: [...SUPPORTED_MODERN_PROTOCOL_VERSIONS] },
    };
  }
  if (meta?.[CLIENT_CAPABILITIES_META_KEY] === undefined) {
    return {
      code: ProtocolErrorCode.InvalidParams,
      message: `Missing required _meta["${CLIENT_CAPABILITIES_META_KEY}"]`,
    };
  }
  return null;
}

// ─── server/discover ────────────────────────────────────────────────────────

export function buildDiscoverResult(opts: DualEraOptions): Record<string, unknown> {
  return {
    _meta: { [SERVER_INFO_META_KEY]: opts.serverInfo },
    supportedVersions: [...SUPPORTED_MODERN_PROTOCOL_VERSIONS],
    capabilities: opts.capabilities,
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
  };
}

// ─── Result decoration ──────────────────────────────────────────────────────

/**
 * Stamp a legacy-shaped result with the modern envelope: `resultType`,
 * `_meta.serverInfo`, and — on list results, where the modern schema requires
 * them — the `ttlMs`/`cacheScope` cache hints.
 */
export function decorateModernResult(
  result: Record<string, unknown>,
  method: string,
  opts: DualEraOptions
): Record<string, unknown> {
  const existingMeta = (result._meta as Record<string, unknown> | undefined) ?? {};
  const cache = opts.listCache ?? DEFAULT_LIST_CACHE;
  return {
    ...result,
    ...(LIST_METHODS.has(method) ? { ttlMs: cache.ttlMs, cacheScope: cache.cacheScope } : {}),
    resultType: 'complete',
    _meta: { ...existingMeta, [SERVER_INFO_META_KEY]: opts.serverInfo },
  };
}

// ─── Transport wrapper ──────────────────────────────────────────────────────

/**
 * Wraps a 1.x server transport and serves both protocol eras over it.
 *
 * Modern requests are answered here — `server/discover` and `_meta` validation
 * never reach the inner Server — while everything else is forwarded unchanged
 * so existing handlers keep working. Responses to modern requests are
 * decorated on the way out.
 */
export class DualEraServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string;

  /** Methods of in-flight modern requests, keyed by JSON-RPC id. */
  private readonly modernInFlight = new Map<string, string>();

  constructor(
    private readonly inner: Transport,
    private readonly opts: DualEraOptions
  ) {}

  private log(level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>): void {
    this.opts.log?.(level, msg, fields);
  }

  async start(): Promise<void> {
    this.inner.onmessage = (message, extra) => this.handleInbound(message, extra);
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (err) => this.onerror?.(err);
    await this.inner.start();
  }

  private handleInbound(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    if (classifyEra(message) === 'legacy') {
      this.onmessage?.(message, extra);
      return;
    }

    const request = message as JsonRpcRequestLike;

    const invalid = validateModernMeta(message);
    if (invalid) {
      this.log('warn', 'modern request rejected', { method: request.method, code: invalid.code });
      void this.inner.send({
        jsonrpc: '2.0',
        id: request.id,
        error: invalid,
      } as unknown as JSONRPCMessage);
      return;
    }

    if (request.method === 'server/discover') {
      void this.inner.send({
        jsonrpc: '2.0',
        id: request.id,
        result: buildDiscoverResult(this.opts),
      } as unknown as JSONRPCMessage);
      return;
    }

    // A valid modern request for a method the existing handlers already serve.
    // Forward it and remember to decorate the response on the way out.
    this.modernInFlight.set(String(request.id), request.method);
    this.onmessage?.(message, extra);
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const id = (message as { id?: RequestId }).id;
    const method = id !== undefined ? this.modernInFlight.get(String(id)) : undefined;

    if (method === undefined) return this.inner.send(message, options);

    this.modernInFlight.delete(String(id));

    // Errors keep their JSON-RPC shape; only results take the modern envelope.
    const result = (message as { result?: Record<string, unknown> }).result;
    if (!result) return this.inner.send(message, options);

    return this.inner.send(
      { ...message, result: decorateModernResult(result, method, this.opts) } as JSONRPCMessage,
      options
    );
  }

  async close(): Promise<void> {
    this.modernInFlight.clear();
    await this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }
}
