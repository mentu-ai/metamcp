/**
 * Disk-based tool schema cache for faster cold starts.
 *
 * Persists tool schemas to ~/.metamcp/cache/<server>/schema.json after
 * first connect. On subsequent starts, the cached schema is loaded
 * immediately so the catalog is populated before the server finishes
 * connecting. The cache is overwritten whenever a fresh listTools()
 * returns different results.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolDefinition } from './types.js';
import { log } from './log.js';

const CACHE_DIR = join(homedir(), '.metamcp', 'cache');
const SCHEMA_FILENAME = 'schema.json';

export interface SchemaCacheSnapshot {
  updatedAt: string;
  tools: ToolDefinition[];
}

function serverCachePath(serverName: string): string {
  return join(CACHE_DIR, serverName, SCHEMA_FILENAME);
}

/**
 * Read cached tool schemas for a server. Returns undefined on miss.
 */
export function readSchemaCache(serverName: string): SchemaCacheSnapshot | undefined {
  const filePath = serverCachePath(serverName);
  try {
    if (!existsSync(filePath)) return undefined;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as SchemaCacheSnapshot;
    if (!parsed?.tools || !Array.isArray(parsed.tools)) return undefined;
    return parsed;
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
    mkdirSync(join(CACHE_DIR, serverName), { recursive: true });
    const snapshot: SchemaCacheSnapshot = {
      updatedAt: new Date().toISOString(),
      tools,
    };
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
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
  if (cached.length !== fresh.length) return true;
  const cachedSet = new Set(cached.map(t => `${t.name}:${t.description ?? ''}`));
  return fresh.some(t => !cachedSet.has(`${t.name}:${t.description ?? ''}`));
}
