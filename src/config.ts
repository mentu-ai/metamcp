import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerConfig } from './types.js';
import { log } from './log.js';

interface McpJsonEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
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

  return Object.entries(servers).map(([name, entry]) => ({
    name,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    criticality: 'vital' as const,
  }));
}
