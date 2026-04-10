/**
 * Skill Catalog — Layer 2 (JIT Context) for the MetaSkill Protocol.
 *
 * Indexes Claude Code skills from personal (~/.claude/skills/) and project
 * (.claude/skills/) directories. Parses extended frontmatter fields for
 * MetaSkill Protocol: requires-mcp, domain, archetype, requires-skills.
 *
 * Two advisory tools consume this catalog:
 *   - mcp_skill_discover(query, domain?) — search skills by keyword
 *   - mcp_skill_advise(skillName) — pre-flight readiness check
 *
 * MetaMCP is advisory — it never invokes skills. Claude Code handles invocation.
 * MetaMCP answers "is this skill ready to use?" not "use this skill."
 *
 * Open source. No hardcoded paths beyond ~/.claude convention.
 *
 * See: MetaSkill Protocol Plan (Phase 3)
 */

import { readFileSync, readdirSync, statSync, existsSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { log } from './log.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SkillArchetype = 'infrastructure' | 'capability' | 'domain';

export interface SkillDefinition {
  name: string;
  description: string;
  domain: string;
  archetype: SkillArchetype;
  requiresMcp: string[];
  requiresSkills: string[];
  path: string;
  source: 'personal' | 'project';
  canonical: boolean;
  version: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
}

export interface SkillMatch {
  skill: SkillDefinition;
  score: number;
  mcpReady: boolean;
}

export interface SkillAdvice {
  skill: SkillDefinition;
  mcpStatus: Record<string, { available: boolean; state: string }>;
  allMcpReady: boolean;
  subSkillStatus: Record<string, boolean>;
  allSubSkillsReady: boolean;
  recommendations: string[];
}

// ─── Frontmatter Parser ─────────────────────────────────────────────────────

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  'requires-mcp'?: string[];
  'requires-skills'?: string[];
  domain?: string;
  archetype?: string;
  canonical?: boolean;
  version?: string;
  'user-invocable'?: boolean;
  'disable-model-invocation'?: boolean;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1]!;
  const result: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Handle array items (  - value)
    if (trimmed.startsWith('- ')) {
      // Find the last key that was set
      const keys = Object.keys(result);
      const lastKey = keys[keys.length - 1];
      if (lastKey && Array.isArray(result[lastKey])) {
        (result[lastKey] as string[]).push(trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ''));
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    // Empty value followed by array items
    if (rawValue === '' || rawValue === '[]') {
      result[key] = rawValue === '[]' ? [] : [];
      continue;
    }

    // Boolean
    if (rawValue === 'true') { result[key] = true; continue; }
    if (rawValue === 'false') { result[key] = false; continue; }

    // Strip quotes and multiline indicator
    let value = rawValue.replace(/^[>'"|]\s*/, '').replace(/['"]$/g, '');
    // Handle inline arrays: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }

    result[key] = value;
  }

  return result as ParsedFrontmatter;
}

// ─── Skill Catalog ──────────────────────────────────────────────────────────

export class SkillCatalog {
  private skills: Map<string, SkillDefinition> = new Map();
  private projectDir: string;
  private personalDir: string;
  private watchers: ReturnType<typeof watch>[] = [];

  constructor(projectDir?: string) {
    this.projectDir = projectDir ?? process.cwd();
    this.personalDir = join(homedir(), '.claude', 'skills');
    this.rebuild();
  }

  /**
   * Rebuild the skill index from disk.
   */
  rebuild(): void {
    this.skills.clear();

    // Personal skills (lower priority — project overrides)
    this.scanDir(this.personalDir, 'personal');

    // Project skills (higher priority)
    const projectSkillDir = join(this.projectDir, '.claude', 'skills');
    this.scanDir(projectSkillDir, 'project');

    log('info', 'skill catalog built', {
      total: this.skills.size,
      personal: [...this.skills.values()].filter(s => s.source === 'personal').length,
      project: [...this.skills.values()].filter(s => s.source === 'project').length,
    });
  }

  /**
   * Search skills by keyword. Returns matches sorted by relevance score.
   */
  search(query: string, domain?: string): SkillMatch[] {
    if (!query && !domain) {
      return [...this.skills.values()].map(skill => ({
        skill,
        score: 1.0,
        mcpReady: true, // caller fills this in via advise()
      }));
    }

    const queryTokens = (query ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const matches: SkillMatch[] = [];

    for (const skill of this.skills.values()) {
      // Domain filter
      if (domain && skill.domain !== domain && skill.domain !== 'general') continue;

      // Score by keyword relevance
      const nameLower = skill.name.toLowerCase();
      const descLower = skill.description.toLowerCase();
      const domainLower = skill.domain.toLowerCase();
      let score = 0;

      for (const token of queryTokens) {
        if (nameLower === token) score += 10;
        else if (nameLower.includes(token)) score += 5;
        if (descLower.includes(token)) score += 2;
        if (domainLower.includes(token)) score += 3;
      }

      // Archetype bonus: capability skills score higher when MCP keywords match
      if (skill.archetype === 'capability') {
        for (const mcp of skill.requiresMcp) {
          for (const token of queryTokens) {
            if (mcp.toLowerCase().includes(token)) score += 4;
          }
        }
      }

      if (score > 0 || (domain && skill.domain === domain)) {
        const maxPossible = queryTokens.length * 15 || 1;
        matches.push({
          skill,
          score: Math.min(score / maxPossible, 1),
          mcpReady: true, // placeholder — caller resolves via checkMcpReadiness
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches;
  }

  /**
   * Pre-flight readiness check for a skill.
   * Checks MCP server availability and sub-skill dependencies.
   */
  advise(
    skillName: string,
    serverChecker: (server: string) => { available: boolean; state: string },
  ): SkillAdvice | null {
    const skill = this.skills.get(skillName);
    if (!skill) return null;

    // Check MCP server readiness
    const mcpStatus: Record<string, { available: boolean; state: string }> = {};
    let allMcpReady = true;
    for (const server of skill.requiresMcp) {
      const status = serverChecker(server);
      mcpStatus[server] = status;
      if (!status.available) allMcpReady = false;
    }

    // Check sub-skill dependencies
    const subSkillStatus: Record<string, boolean> = {};
    let allSubSkillsReady = true;
    for (const subSkill of skill.requiresSkills) {
      const exists = this.skills.has(subSkill);
      subSkillStatus[subSkill] = exists;
      if (!exists) allSubSkillsReady = false;
    }

    // Build recommendations
    const recommendations: string[] = [];
    for (const [server, status] of Object.entries(mcpStatus)) {
      if (!status.available) {
        if (status.state === 'closed' || status.state === '') {
          recommendations.push(`Provision "${server}" first via mcp_provision`);
        } else if (status.state === 'failed') {
          recommendations.push(`Server "${server}" circuit breaker is open — wait for cooldown or investigate`);
        } else {
          recommendations.push(`Server "${server}" is ${status.state} — wait for it to become idle`);
        }
      }
    }
    for (const [subSkill, exists] of Object.entries(subSkillStatus)) {
      if (!exists) {
        recommendations.push(`Required sub-skill "${subSkill}" not found in catalog`);
      }
    }

    return {
      skill,
      mcpStatus,
      allMcpReady,
      subSkillStatus,
      allSubSkillsReady,
      recommendations,
    };
  }

  /**
   * Enrich search results with MCP readiness status.
   */
  enrichWithReadiness(
    matches: SkillMatch[],
    serverChecker: (server: string) => { available: boolean; state: string },
  ): SkillMatch[] {
    return matches.map(m => ({
      ...m,
      mcpReady: m.skill.requiresMcp.every(s => serverChecker(s).available),
    }));
  }

  /**
   * Get a skill by name.
   */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /**
   * Get all skills.
   */
  getAll(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  /**
   * Get skills grouped by archetype.
   */
  byArchetype(): Record<SkillArchetype, SkillDefinition[]> {
    const result: Record<SkillArchetype, SkillDefinition[]> = {
      infrastructure: [],
      capability: [],
      domain: [],
    };
    for (const skill of this.skills.values()) {
      result[skill.archetype].push(skill);
    }
    return result;
  }

  /**
   * Start watching skill directories for changes.
   */
  startWatching(): void {
    this.stopWatching();

    const dirs = [this.personalDir, join(this.projectDir, '.claude', 'skills')];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, (event, filename) => {
          if (filename && filename.endsWith('SKILL.md')) {
            log('info', 'skill file changed, rebuilding catalog', { event, filename });
            this.rebuild();
          }
        });
        this.watchers.push(watcher);
      } catch {
        // Watch not supported on all platforms
      }
    }
  }

  /**
   * Stop watching skill directories.
   */
  stopWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private scanDir(dir: string, source: 'personal' | 'project'): void {
    if (!existsSync(dir)) return;

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const skillDir = join(dir, entry);
        try {
          if (!statSync(skillDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const skillFile = join(skillDir, 'SKILL.md');
        if (!existsSync(skillFile)) continue;

        try {
          const content = readFileSync(skillFile, 'utf-8');
          const fm = parseFrontmatter(content);

          const name = fm.name ?? entry;
          const definition: SkillDefinition = {
            name,
            description: fm.description ?? extractFirstParagraph(content),
            domain: fm.domain ?? 'general',
            archetype: (fm.archetype as SkillArchetype) ?? inferArchetype(fm),
            requiresMcp: fm['requires-mcp'] ?? [],
            requiresSkills: fm['requires-skills'] ?? [],
            path: resolve(skillFile),
            source,
            canonical: fm.canonical ?? false,
            version: fm.version ?? '0.0.0',
            userInvocable: fm['user-invocable'] !== false,
            disableModelInvocation: fm['disable-model-invocation'] === true,
          };

          // Project skills override personal skills with same name
          this.skills.set(name, definition);
        } catch (err) {
          log('warn', 'failed to parse skill', {
            path: skillFile,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log('warn', 'failed to scan skill directory', {
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─── Server→Skill Reverse Lookup ─────────────────────────────────────────

/** Server→skill mapping — which skill teaches how to use each MCP server. */
const SERVER_SKILL_MAP: Record<string, string> = {
  'spectre': 'spectre-intelligence',
  'crawlio': 'crawlio-mcp',
  'crawlio-agent-headless': 'browser-automation',
  'crawlio-agent': 'browser-automation',
  'crawlio-browser': 'browser-automation',
  'mentu': 'mentu',
  'mentu-commander': 'mentu-commander',
  'mentu-ane': 'mentu-ane',
  'mentu-runtime': 'mentu-runtime',
  'mentu-desktop': 'mentu-desktop',
  'mentu-local': 'mentu-local',
  'playwright': 'playwright',
  'Neon': 'neon-postgres',
  'neon': 'neon-postgres',
  'Sentry': 'sentry',
  'sentry': 'sentry',
  'cloudflare': 'cloudflare',
  'airtable': 'airtable',
  'discord': 'discord',
  'perplexity': 'perplexity',
  'context7': 'context7',
  'paddle': 'paddle',
  'resend': 'resend',
  'XcodeBuildMCP': 'xcodebuildmcp',
};

/** Find the skill that teaches how to use a given MCP server. */
export function findSkillForServer(serverName: string): { skillName: string; skillPath: string } | null {
  const skillName = SERVER_SKILL_MAP[serverName];
  if (!skillName) return null;

  const paths = [
    join(homedir(), '.mentu', 'skill-library', '.claude', 'skills', skillName, 'SKILL.md'),
    join(homedir(), '.claude', 'skills', skillName, 'SKILL.md'),
  ];

  for (const p of paths) {
    if (existsSync(p)) return { skillName, skillPath: p };
  }

  return { skillName, skillPath: '' };  // skill known but file not found
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function extractFirstParagraph(content: string): string {
  // Skip frontmatter
  const body = content.replace(/^---[\s\S]*?---\n*/, '');
  // Skip headers
  const lines = body.split('\n').filter(l => !l.startsWith('#') && l.trim().length > 0);
  return lines[0]?.trim() ?? '';
}

function inferArchetype(fm: ParsedFrontmatter): SkillArchetype {
  if (fm['requires-mcp'] && fm['requires-mcp'].length > 0) return 'capability';
  if (fm['user-invocable'] === false) return 'infrastructure';
  return 'domain';
}
