/**
 * Disk-based tool schema cache for faster cold starts.
 *
 * Persists tool schemas to ~/.metamcp/cache/<server>/schema.json after
 * first connect. On subsequent starts, the cached schema is loaded
 * immediately so the catalog is populated before the server finishes
 * connecting. The cache is overwritten whenever a fresh listTools()
 * returns different results.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { isValidServerName, type ToolDefinition } from './types.js';
import { log } from './log.js';

const SCHEMA_FILENAME = 'schema.json';
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_TOOLS = 10_000;

export interface SchemaCacheSnapshot {
  updatedAt: string;
  tools: ToolDefinition[];
}

function serverCachePath(serverName: string): string {
  if (!isValidServerName(serverName)) throw new Error(`Invalid server name for schema cache: ${serverName}`);
  const cacheDir = process.env.METAMCP_CACHE_DIR || join(homedir(), '.metamcp', 'cache');
  return join(cacheDir, serverName, SCHEMA_FILENAME);
}

/**
 * Read cached tool schemas for a server. Returns undefined on miss.
 */
export function readSchemaCache(serverName: string): SchemaCacheSnapshot | undefined {
  const filePath = serverCachePath(serverName);
  try {
    if (!existsSync(filePath)) return undefined;
    if (statSync(filePath).size > MAX_CACHE_BYTES) return undefined;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.updatedAt !== 'string' || !Array.isArray(parsed.tools)) return undefined;
    if (parsed.tools.length > MAX_CACHED_TOOLS || !parsed.tools.every(tool => isToolDefinition(tool, serverName))) return undefined;
    return parsed as unknown as SchemaCacheSnapshot;
  } catch {
    return undefined;
  }
}

/**
 * Write tool schemas to disk cache. Creates directories as needed.
 */
export function writeSchemaCache(serverName: string, tools: ToolDefinition[]): void {
  const filePath = serverCachePath(serverName);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const snapshot: SchemaCacheSnapshot = {
      updatedAt: new Date().toISOString(),
      tools,
    };
    const serialized = JSON.stringify(snapshot, null, 2);
    if (Buffer.byteLength(serialized, 'utf-8') > MAX_CACHE_BYTES) {
      throw new Error(`schema cache exceeds ${MAX_CACHE_BYTES} bytes`);
    }
    const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(temporary, serialized, { encoding: 'utf-8', mode: 0o600 });
      renameSync(temporary, filePath);
    } catch (err) {
      try { unlinkSync(temporary); } catch { /* no temporary file to remove */ }
      throw err;
    }
  } catch (err) {
    log('warn', 'failed to write schema cache', {
      server: serverName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Check if cached tools differ from fresh tools (by name+description).
 * Returns true if cache should be updated.
 */
export function isCacheStale(cached: ToolDefinition[], fresh: ToolDefinition[]): boolean {
  return canonicalTools(cached) !== canonicalTools(fresh);
}

function canonicalTools(tools: ToolDefinition[]): string {
  const sorted = [...tools].sort((a, b) =>
    a.server.localeCompare(b.server) || a.name.localeCompare(b.name) || (a.description ?? '').localeCompare(b.description ?? '')
  );
  return JSON.stringify(canonicalize(sorted));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function isToolDefinition(value: unknown, serverName: string): value is ToolDefinition {
  return isRecord(value)
    && typeof value.name === 'string'
    && value.name.length > 0
    && value.name.length <= 256
    && value.server === serverName
    && (value.description === undefined || typeof value.description === 'string')
    && (value.inputSchema === undefined || isRecord(value.inputSchema));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
