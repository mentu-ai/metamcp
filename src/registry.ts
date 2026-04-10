import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { RegistryEntry } from './types.js';

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/servers';
const CACHE_DIR = join(homedir(), '.metamcp');
const CACHE_FILE = join(CACHE_DIR, 'registry-cache.json');
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

interface CacheData {
  timestamp: number;
  entries: RegistryEntry[];
}

const FALLBACK_SERVERS: RegistryEntry[] = [
  { name: '@modelcontextprotocol/server-filesystem', description: 'File system operations', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], namespace: '@modelcontextprotocol' },
  { name: '@modelcontextprotocol/server-github', description: 'GitHub API integration', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], namespace: '@modelcontextprotocol' },
  { name: '@modelcontextprotocol/server-gitlab', description: 'GitLab API integration', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'], namespace: '@modelcontextprotocol' },
  { name: '@modelcontextprotocol/server-google-maps', description: 'Google Maps API', command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-maps'], namespace: '@modelcontextprotocol' },
  { name: '@modelcontextprotocol/server-memory', description: 'Knowledge graph memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], namespace: '@modelcontextprotocol' },
  { name: '@modelcontextprotocol/server-postgres', description: 'PostgreSQL database access', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'], namespace: '@modelcontextprotocol' },
  { name: '@modelcontextprotocol/server-slack', description: 'Slack workspace integration', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], namespace: '@modelcontextprotocol' },
  { name: '@modelcontextprotocol/server-sqlite', description: 'SQLite database access', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite'], namespace: '@modelcontextprotocol' },
  { name: '@modelcontextprotocol/server-brave-search', description: 'Brave search engine', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], namespace: '@modelcontextprotocol' },
  { name: '@modelcontextprotocol/server-puppeteer', description: 'Browser automation with Puppeteer', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'], namespace: '@modelcontextprotocol' },
  { name: '@modelcontextprotocol/server-fetch', description: 'HTTP fetch and web scraping', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], namespace: '@modelcontextprotocol' },
  { name: '@modelcontextprotocol/server-everything', description: 'Reference server with all features', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], namespace: '@modelcontextprotocol' },
  { name: '@anthropic/server-sequential-thinking', description: 'Sequential thinking and reasoning', command: 'npx', args: ['-y', '@anthropic/server-sequential-thinking'], namespace: '@anthropic' },
  { name: '@playwright/mcp', description: 'Browser automation with Playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], namespace: '@playwright' },
  { name: '@stripe/mcp', description: 'Stripe payment integration', command: 'npx', args: ['-y', '@stripe/mcp'], namespace: '@stripe' },
  { name: '@sentry/mcp-server', description: 'Sentry error tracking', command: 'npx', args: ['-y', '@sentry/mcp-server'], namespace: '@sentry' },
  { name: 'mcp-server-docker', description: 'Docker container management', command: 'npx', args: ['-y', 'mcp-server-docker'], namespace: 'mcp-server-docker' },
  { name: 'mcp-server-kubernetes', description: 'Kubernetes cluster management', command: 'npx', args: ['-y', 'mcp-server-kubernetes'], namespace: 'mcp-server-kubernetes' },
  { name: 'mcp-server-git', description: 'Git repository operations', command: 'npx', args: ['-y', 'mcp-server-git'], namespace: 'mcp-server-git' },
  { name: 'mcp-server-linear', description: 'Linear project management', command: 'npx', args: ['-y', 'mcp-server-linear'], namespace: 'mcp-server-linear' },
];

export class MCPRegistry {
  private entries: RegistryEntry[] = [];
  private lastRefresh = 0;

  async refresh(): Promise<void> {
    // Try API first
    try {
      const response = await fetch(REGISTRY_URL);
      if (response.ok) {
        const data = await response.json() as Array<{
          name?: string;
          description?: string;
          command?: string;
          args?: string[];
          namespace?: string;
        }>;
        this.entries = data
          .filter((e): e is { name: string; description: string; command: string; args?: string[]; namespace?: string } =>
            typeof e.name === 'string' && typeof e.description === 'string'
          )
          .map(e => ({
            name: e.name,
            description: e.description,
            command: e.command ?? 'npx',
            args: e.args ?? ['-y', e.name],
            namespace: e.namespace ?? extractNamespace(e.name),
          }));
        this.lastRefresh = Date.now();
        this.saveCache();
        return;
      }
    } catch {
      // API unavailable — fall through
    }

    // Try cache
    if (this.loadCache()) return;

    // Fallback to bundled list
    this.entries = [...FALLBACK_SERVERS];
    this.lastRefresh = Date.now();
  }

  async getEntries(): Promise<RegistryEntry[]> {
    if (this.entries.length === 0 || Date.now() - this.lastRefresh > REFRESH_INTERVAL_MS) {
      await this.refresh();
    }
    return this.entries;
  }

  search(query: string): RegistryEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return [];

    const scored: Array<{ entry: RegistryEntry; score: number }> = [];

    for (const entry of this.entries) {
      let score = 0;
      const nameLower = entry.name.toLowerCase();
      const descLower = entry.description.toLowerCase();

      for (const word of words) {
        if (nameLower === word) score += 10;
        else if (nameLower.includes(word)) score += 5;
        if (descLower.includes(word)) score += 2;
      }

      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.entry);
  }

  private saveCache(): void {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      const data: CacheData = {
        timestamp: this.lastRefresh,
        entries: this.entries,
      };
      writeFileSync(CACHE_FILE, JSON.stringify(data));
    } catch {
      // ignore cache write errors
    }
  }

  private loadCache(): boolean {
    try {
      const raw = readFileSync(CACHE_FILE, 'utf-8');
      const data = JSON.parse(raw) as CacheData;
      if (data.entries && data.entries.length > 0) {
        this.entries = data.entries;
        this.lastRefresh = data.timestamp;
        return true;
      }
    } catch {
      // cache miss
    }
    return false;
  }
}

function extractNamespace(name: string): string {
  if (name.startsWith('@')) {
    const slashIndex = name.indexOf('/');
    if (slashIndex > 0) {
      return name.substring(0, slashIndex);
    }
  }
  return name;
}
