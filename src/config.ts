import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerConfig, ServerLifecycle, TransportType } from './types.js';
import { log } from './log.js';

interface McpJsonEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transportType?: string;
  headers?: Record<string, string>;
  oauth?: boolean;
  timeoutMs?: number;
  lifecycle?: string | { mode: string; idleTimeoutMs?: number };
}

interface McpJsonFile {
  mcpServers?: Record<string, McpJsonEntry>;
}

export function loadConfig(configPath?: string): ServerConfig[] {
  const path = configPath ?? resolve(process.cwd(), '.mcp.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    const example = resolve(process.cwd(), '.mcp.example.json');
    if (existsSync(example)) {
      log('warn', '.mcp.json not found — copy .mcp.example.json to .mcp.json and edit it');
    }
    return [];
  }

  let parsed: McpJsonFile;
  try {
    parsed = JSON.parse(raw) as McpJsonFile;
  } catch {
    log('error', 'config parse failed', { path });
    return [];
  }

  const servers = parsed.mcpServers;
  if (!servers) return [];

  const result: ServerConfig[] = [];

  for (const [name, entry] of Object.entries(servers)) {
    if (!entry.command && !entry.url) {
      log('warn', 'server entry missing both command and url, skipping', { name });
      continue;
    }

    const config: ServerConfig = {
      name,
      command: entry.command ?? '',
      criticality: 'vital',
    };

    if (entry.args) config.args = entry.args;
    if (entry.env) config.env = entry.env;
    if (entry.url) {
      config.url = entry.url;
      const t = entry.transportType?.toLowerCase();
      config.transport = t === 'sse' ? 'sse' : 'http';
    }
    if (entry.headers) config.headers = entry.headers;
    if (entry.oauth) config.oauth = entry.oauth;
    if (entry.timeoutMs) config.timeoutMs = entry.timeoutMs;
    if (entry.lifecycle) config.lifecycle = parseLifecycle(entry.lifecycle);

    result.push(config);
  }

  return result;
}

function parseLifecycle(raw: string | { mode: string; idleTimeoutMs?: number }): ServerLifecycle | undefined {
  if (typeof raw === 'string') {
    if (raw === 'keep-alive') return { mode: 'keep-alive' };
    if (raw === 'ephemeral') return { mode: 'ephemeral' };
    return undefined;
  }
  if (raw.mode === 'keep-alive') {
    const timeout = typeof raw.idleTimeoutMs === 'number' && raw.idleTimeoutMs > 0
      ? Math.trunc(raw.idleTimeoutMs)
      : undefined;
    return timeout ? { mode: 'keep-alive', idleTimeoutMs: timeout } : { mode: 'keep-alive' };
  }
  if (raw.mode === 'ephemeral') return { mode: 'ephemeral' };
  return undefined;
}
