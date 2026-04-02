/**
 * Auto-discover MCP server configs from installed editors and clients.
 *
 * Scans known config paths for Cursor, Claude Code, Claude Desktop,
 * Codex, Windsurf, OpenCode, and VS Code. Merges discovered servers
 * into the MetaMCP config so users get zero-config server discovery.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import type { ServerConfig, TransportType } from './types.js';
import { log } from './log.js';

export type ImportKind = 'cursor' | 'claude-code' | 'claude-desktop' | 'codex' | 'windsurf' | 'opencode' | 'vscode';

export const ALL_IMPORT_KINDS: ImportKind[] = [
  'cursor', 'claude-code', 'claude-desktop', 'codex', 'windsurf', 'opencode', 'vscode',
];

/**
 * Returns all known config file paths for a given editor/client.
 */
export function pathsForImport(kind: ImportKind, rootDir: string): string[] {
  const home = homedir();

  switch (kind) {
    case 'cursor':
      return dedupe([
        resolve(rootDir, '.cursor', 'mcp.json'),
        join(home, '.cursor', 'mcp.json'),
        ...cursorUserPaths(home),
      ]);

    case 'claude-code':
      return dedupe([
        resolve(rootDir, '.claude', 'settings.local.json'),
        resolve(rootDir, '.claude', 'settings.json'),
        resolve(rootDir, '.claude', 'mcp.json'),
        join(home, '.claude', 'settings.local.json'),
        join(home, '.claude', 'settings.json'),
        join(home, '.claude', 'mcp.json'),
        join(home, '.claude.json'),
      ]);

    case 'claude-desktop':
      return [claudeDesktopPath(home)];

    case 'codex':
      return [
        resolve(rootDir, '.codex', 'config.toml'),
        join(home, '.codex', 'config.toml'),
      ];

    case 'windsurf':
      return windsurfPaths(home);

    case 'opencode':
      return opencodePaths(rootDir, home);

    case 'vscode':
      return dedupe([
        resolve(rootDir, '.vscode', 'mcp.json'),
        ...vscodePaths(home),
      ]);

    default:
      return [];
  }
}

/**
 * Discover all MCP servers configured across installed editors.
 * Returns configs keyed by server name. First-seen wins on conflicts.
 */
export function discoverExternalServers(
  rootDir: string,
  kinds?: ImportKind[],
): Map<string, { config: ServerConfig; source: string }> {
  const discovered = new Map<string, { config: ServerConfig; source: string }>();
  const importKinds = kinds ?? ALL_IMPORT_KINDS;

  for (const kind of importKinds) {
    const paths = pathsForImport(kind, rootDir);
    for (const configPath of paths) {
      if (!existsSync(configPath)) continue;

      try {
        const entries = readConfigFile(configPath, kind);
        for (const [name, config] of entries) {
          if (!discovered.has(name)) {
            discovered.set(name, { config, source: `${kind}:${configPath}` });
          }
        }
      } catch (err) {
        log('warn', 'failed to read external config', {
          kind,
          path: configPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return discovered;
}

// ─── Config File Readers ──────────────────────────────────────────────────

function readConfigFile(filePath: string, kind: ImportKind): Map<string, ServerConfig> {
  const raw = readFileSync(filePath, 'utf-8');
  if (!raw.trim()) return new Map();

  // TOML (Codex)
  if (filePath.endsWith('.toml')) {
    return readCodexToml(raw);
  }

  // JSON
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }

  return extractServersFromJson(parsed, kind, filePath);
}

function extractServersFromJson(
  raw: Record<string, unknown>,
  kind: ImportKind,
  filePath: string,
): Map<string, ServerConfig> {
  const result = new Map<string, ServerConfig>();

  // Try containers in priority order based on editor conventions
  const containers: Record<string, unknown>[] = [];

  const mcpServers = raw.mcpServers as Record<string, unknown> | undefined;
  const servers = raw.servers as Record<string, unknown> | undefined;
  const mcp = raw.mcp as Record<string, unknown> | undefined;

  if (mcpServers && typeof mcpServers === 'object') containers.push(mcpServers);
  if (servers && typeof servers === 'object') containers.push(servers);
  if (kind === 'opencode' && mcp && typeof mcp === 'object') containers.push(mcp);

  // Root fallback for legacy files
  if (containers.length === 0) {
    const normalized = normalize(filePath);
    const isLegacy = normalized.endsWith('.claude.json') || normalized.endsWith('.cursor/mcp.json');
    if (isLegacy) containers.push(raw);
  }

  for (const container of containers) {
    for (const [name, value] of Object.entries(container)) {
      if (result.has(name)) continue;
      if (!value || typeof value !== 'object') continue;
      const config = convertEntry(name, value as Record<string, unknown>);
      if (config) result.set(name, config);
    }
  }

  return result;
}

function readCodexToml(raw: string): Map<string, ServerConfig> {
  // Simple TOML parsing for [mcp_servers.<name>] sections
  const result = new Map<string, ServerConfig>();
  const lines = raw.split('\n');
  let currentServer: string | null = null;
  let currentEntry: Record<string, unknown> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (sectionMatch) {
      if (currentServer) {
        const config = convertEntry(currentServer, currentEntry);
        if (config) result.set(currentServer, config);
      }
      currentServer = sectionMatch[1];
      currentEntry = {};
      continue;
    }
    if (currentServer && trimmed.includes('=')) {
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val.startsWith('[') && val.endsWith(']')) {
        try { currentEntry[key] = JSON.parse(val); } catch { /* skip */ }
      } else {
        currentEntry[key] = val;
      }
    }
  }

  if (currentServer) {
    const config = convertEntry(currentServer, currentEntry);
    if (config) result.set(currentServer, config);
  }

  return result;
}

function convertEntry(name: string, value: Record<string, unknown>): ServerConfig | null {
  const url = asString(value.baseUrl ?? value.base_url ?? value.url ?? value.serverUrl ?? value.server_url);
  const command = typeof value.command === 'string' ? value.command : undefined;
  const args = Array.isArray(value.args) ? value.args.filter((a): a is string => typeof a === 'string') : undefined;

  if (!url && !command) return null;

  const config: ServerConfig = {
    name,
    command: command ?? '',
    criticality: 'vital',
  };

  if (args) config.args = args;

  const env = asStringRecord(value.env);
  if (env) config.env = env;

  if (url) {
    config.url = url;
    config.transport = 'http' as TransportType;
  }

  const headers = asStringRecord(value.headers);
  if (headers) config.headers = headers;

  // Bearer token support
  const bearerToken = asString(value.bearerToken ?? value.bearer_token);
  if (bearerToken) {
    config.headers = { ...config.headers, Authorization: `Bearer ${bearerToken}` };
  }

  if (value.auth === 'oauth' || value.oauth === true) {
    config.oauth = true;
  }

  return config;
}

// ─── Platform-Specific Paths ──────────────────────────────────────────────

function cursorUserPaths(home: string): string[] {
  return dedupe([
    join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'mcp.json'),
    join(home, 'Library', 'Application Support', 'Cursor', 'User', 'mcp.json'),
    ...(process.env.XDG_CONFIG_HOME
      ? [join(process.env.XDG_CONFIG_HOME, 'Cursor', 'User', 'mcp.json')]
      : []),
  ]);
}

function claudeDesktopPath(home: string): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'settings.json');
  if (process.platform === 'win32') return join(home, 'AppData', 'Roaming', 'Claude', 'settings.json');
  return join(home, '.config', 'Claude', 'settings.json');
}

function windsurfPaths(home: string): string[] {
  const paths = [
    join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    join(home, '.codeium', 'windsurf-next', 'mcp_config.json'),
    join(home, '.windsurf', 'mcp_config.json'),
    join(home, '.config', '.codeium', 'windsurf', 'mcp_config.json'),
  ];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    paths.push(join(appData, 'Codeium', 'windsurf', 'mcp_config.json'));
  }
  return dedupe(paths);
}

function vscodePaths(home: string): string[] {
  if (process.platform === 'darwin') {
    return [
      join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'mcp.json'),
    ];
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return [join(appData, 'Code', 'User', 'mcp.json'), join(appData, 'Code - Insiders', 'User', 'mcp.json')];
  }
  return [
    join(home, '.config', 'Code', 'User', 'mcp.json'),
    join(home, '.config', 'Code - Insiders', 'User', 'mcp.json'),
  ];
}

function opencodePaths(rootDir: string, home: string): string[] {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  const paths = [
    resolve(rootDir, 'opencode.jsonc'),
    resolve(rootDir, 'opencode.json'),
    resolve(rootDir, '.openai', 'config.json'),
    join(configHome, 'openai', 'config.json'),
    join(configHome, 'opencode', 'opencode.jsonc'),
    join(configHome, 'opencode', 'opencode.json'),
  ];
  const envConfig = process.env.OPENCODE_CONFIG;
  if (envConfig) paths.unshift(envConfig);
  const envDir = process.env.OPENCODE_CONFIG_DIR;
  if (envDir) {
    paths.push(join(envDir, 'opencode.jsonc'), join(envDir, 'opencode.json'));
  }
  return dedupe(paths);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function dedupe(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter(p => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringRecord(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') record[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') record[key] = String(value);
  }
  return Object.keys(record).length > 0 ? record : undefined;
}
