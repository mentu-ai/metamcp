/**
 * Child-server era detection (MCP 2026-07-28).
 *
 * The gateway now serves both protocol eras (see src/dual-era.ts). Toward the
 * child servers it connects to, it also needs to know which era each one
 * speaks, so the migration can be driven per server instead of all at once.
 *
 * Detection follows the spec's dual-era client guidance: ask for
 * `server/discover`. A modern server answers with its supported revisions; a
 * legacy server has no such method and replies MethodNotFound. The verdict is
 * cached per server, because it is a property of the server build and does not
 * change between calls within a process.
 *
 * Scope note: knowing a child is modern does not by itself make our outbound
 * calls modern. Requests are built by `@modelcontextprotocol/sdk` 1.x, which
 * only emits legacy-era frames; speaking the modern era outbound requires
 * migrating the client runtime to `@modelcontextprotocol/client` 2.x. This
 * module is the detection and bookkeeping half, and it is what makes that
 * migration incremental — it reports which children are ready.
 */

import { McpError, ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { FIRST_MODERN_PROTOCOL_VERSION, isModernProtocolVersion } from './dual-era.js';

/** JSON-RPC MethodNotFound — a legacy server's answer to `server/discover`. */
const METHOD_NOT_FOUND = -32601;
/**
 * The SDK validates every response against a schema before handing it back, so
 * a schema is required even though we do our own reading of the result.
 *
 * `ResultSchema` is the SDK's own permissive result type: it accepts any
 * additional fields and preserves them, which is what a discover reply needs
 * (an unknown-but-valid extension must not become a parse failure). Using the
 * SDK's schema also avoids importing `zod` directly — it is not a declared
 * dependency of this package, and the SDK permits either zod 3 or 4, whose
 * object APIs differ.
 */
export const PASSTHROUGH_RESULT_SCHEMA = ResultSchema;


export type ServerEra = 'modern' | 'legacy' | 'unknown';

export interface EraProbeResult {
  era: ServerEra;
  /** Modern revisions the child advertises, when it is modern. */
  supportedVersions?: string[];
  capabilities?: Record<string, unknown>;
  /** Why the verdict is `unknown` — transport error, malformed reply, etc. */
  reason?: string;
}

/**
 * Permissive reading of the discover reply. Only `supportedVersions` is needed
 * to reach a verdict, so everything else is left alone — a strict schema would
 * turn an unknown-but-valid extension into a false `unknown`.
 *
 * Hand-rolled rather than a Zod schema on purpose: `zod` is not a declared
 * dependency of this package, and the version the SDK pulls in may be v3 or v4,
 * whose object APIs differ. Two field checks are not worth that coupling.
 */
interface DiscoverShape {
  supportedVersions?: string[];
  capabilities?: Record<string, unknown>;
}

function readDiscoverResult(raw: unknown): DiscoverShape | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const versions = obj.supportedVersions;
  if (versions !== undefined && !(Array.isArray(versions) && versions.every((v) => typeof v === 'string'))) {
    return null;
  }
  const capabilities = obj.capabilities;
  if (capabilities !== undefined && (typeof capabilities !== 'object' || capabilities === null)) {
    return null;
  }
  return {
    ...(versions !== undefined ? { supportedVersions: versions as string[] } : {}),
    ...(capabilities !== undefined ? { capabilities: capabilities as Record<string, unknown> } : {}),
  };
}

/** Minimal surface this module needs from an MCP client. */
export interface ProbeableClient {
  request<T>(request: { method: string; params?: Record<string, unknown> }, schema: unknown, options?: unknown): Promise<T>;
}

/**
 * Ask a connected child whether it speaks the modern era.
 *
 * Never throws: a probe failure is a verdict, not an outage. An unreachable or
 * malformed server yields `unknown` and the caller keeps using the legacy path.
 */
export async function probeServerEra(
  client: ProbeableClient,
  options: { timeoutMs?: number } = {}
): Promise<EraProbeResult> {
  try {
    const raw = await client.request<unknown>(
      { method: 'server/discover' },
      PASSTHROUGH_RESULT_SCHEMA,
      { timeout: options.timeoutMs ?? 10_000 }
    );

    const parsed = readDiscoverResult(raw);
    if (!parsed) {
      return { era: 'unknown', reason: 'server/discover returned an unreadable result' };
    }

    const versions = parsed.supportedVersions ?? [];
    const modern = versions.filter(isModernProtocolVersion);
    if (modern.length === 0) {
      // Answered, but advertises no modern revision we can speak.
      return {
        era: 'legacy',
        supportedVersions: versions,
        reason: `no supported modern revision (need ≥ ${FIRST_MODERN_PROTOCOL_VERSION})`,
      };
    }

    return {
      era: 'modern',
      supportedVersions: modern,
      capabilities: parsed.capabilities,
    };
  } catch (err) {
    // MethodNotFound is the expected, healthy answer from a legacy server.
    if (err instanceof McpError && err.code === METHOD_NOT_FOUND) {
      return { era: 'legacy' };
    }
    if (isMethodNotFound(err)) return { era: 'legacy' };
    return {
      era: 'unknown',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Some transports surface a JSON-RPC error without wrapping it in McpError,
 * so fall back to reading the code off the error shape.
 */
function isMethodNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === METHOD_NOT_FOUND;
}

/**
 * Per-server era verdicts for the lifetime of the process.
 *
 * `unknown` is deliberately not cached: it means the probe could not reach a
 * verdict, which is usually transient, and caching it would pin a server to the
 * legacy path for the whole session over one timeout.
 */
export class EraCache {
  private readonly entries = new Map<string, EraProbeResult>();

  get(serverName: string): EraProbeResult | undefined {
    return this.entries.get(serverName);
  }

  set(serverName: string, result: EraProbeResult): void {
    if (result.era === 'unknown') return;
    this.entries.set(serverName, result);
  }

  /** Probe once per server, reusing the cached verdict afterwards. */
  async resolve(
    serverName: string,
    client: ProbeableClient,
    options?: { timeoutMs?: number }
  ): Promise<EraProbeResult> {
    const cached = this.entries.get(serverName);
    if (cached) return cached;
    const result = await probeServerEra(client, options);
    this.set(serverName, result);
    return result;
  }

  forget(serverName: string): void {
    this.entries.delete(serverName);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Server names known to speak the modern era — the migration-ready set. */
  modernServers(): string[] {
    return [...this.entries.entries()].filter(([, r]) => r.era === 'modern').map(([name]) => name);
  }

  get size(): number {
    return this.entries.size;
  }
}
