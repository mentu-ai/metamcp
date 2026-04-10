/**
 * skill-catalog.ts — Index and search Claude Code skills with MCP readiness checks.
 *
 * Scans two directories for SKILL.md files:
 *   1. ~/.claude/skills/        (personal / infrastructure)
 *   2. <cwd>/.claude/skills/    (project / domain — overrides personal)
 *
 * Parses standard frontmatter + MetaSkill Protocol extensions.
 * Advisory only — never invokes skills.
 */
import { readFileSync, existsSync, readdirSync, statSync, watch } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { log } from './log.js';

// --- Types ---

export type SkillArchetype = 'infrastructure' | 'capability' | 'domain';

export interface SkillEntry {
  name: string;
  description: string;
  domain?: string;
  archetype?: SkillArchetype;
  requiresMcp: string[];
  requiresSkills: string[];
  version?: string;
  source: 'personal' | 'project';
  path: string;
}

export interface SkillMatch extends SkillEntry {
  score: number;
  mcpReady: boolean;
  mcpStatus: Record<string, { available: boolean; state: string }>;
}

export interface SkillAdvice {
  skill: string;
  domain?: string;
  archetype?: SkillArchetype;
  ready: boolean;
  mcpStatus: Record<string, { available: boolean; state: string }>;
  recommendations: string[];
}

// --- Frontmatter parser ---

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result: Record<string, unknown> = {};
  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    let value: unknown = raw.trim();
    // Parse arrays: [a, b, c] or ["a", "b"]
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    // Parse booleans
    if (value === 'true') value = true;
    if (value === 'false') value = false;
    result[key] = value;
  }
  return result;
}

// --- Skill scanner ---

function scanDirectory(dir: string, source: 'personal' | 'project'): SkillEntry[] {
  if (!existsSync(dir)) return [];
  const entries: SkillEntry[] = [];

  try {
    for (const item of readdirSync(dir)) {
      const skillDir = join(dir, item);
      if (!statSync(skillDir).isDirectory()) continue;
      const skillFile = join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      try {
        const content = readFileSync(skillFile, 'utf-8');
        const fm = parseFrontmatter(content);
        const name = (fm.name as string) || basename(skillDir);
        const requiresMcp = Array.isArray(fm['requires-mcp']) ? fm['requires-mcp'] as string[] : [];
        const requiresSkills = Array.isArray(fm['requires-skills']) ? fm['requires-skills'] as string[] : [];

        entries.push({
          name,
          description: (fm.description as string) || '',
          domain: fm.domain as string | undefined,
          archetype: fm.archetype as SkillArchetype | undefined,
          requiresMcp,
          requiresSkills,
          version: fm.version as string | undefined,
          source,
          path: skillFile,
        });
      } catch {
        log('warn', 'failed to parse skill', { path: skillFile });
      }
    }
  } catch {
    log('warn', 'failed to scan skill directory', { dir });
  }

  return entries;
}

// --- SkillCatalog ---

export type ServerChecker = (serverName: string) => { available: boolean; state: string };

export class SkillCatalog {
  private skills: Map<string, SkillEntry> = new Map();
  private scanDirs: { dir: string; source: 'personal' | 'project' }[];

  constructor(projectRoot?: string) {
    const home = homedir();
    this.scanDirs = [
      { dir: join(home, '.claude', 'skills'), source: 'personal' },
      { dir: join(home, '.mentu', 'skill-library', '.claude', 'skills'), source: 'personal' },
      { dir: join(projectRoot ?? process.cwd(), '.claude', 'skills'), source: 'project' },
    ];
    this.reload();
    this.startWatching();
  }

  reload(): void {
    this.skills.clear();
    // Scan in order — later entries override earlier ones (project overrides personal)
    for (const { dir, source } of this.scanDirs) {
      for (const entry of scanDirectory(dir, source)) {
        this.skills.set(entry.name, entry);
      }
    }
    // log('info', ...) omitted — noisy during CLI usage
  }

  private startWatching(): void {
    for (const { dir } of this.scanDirs) {
      if (!existsSync(dir)) continue;
      try {
        watch(dir, { recursive: true }, (_event, filename) => {
          if (filename && (filename.endsWith('SKILL.md') || filename.endsWith('.md'))) {
            setTimeout(() => this.reload(), 500);
          }
        });
      } catch { /* non-fatal */ }
    }
  }

  /** Keyword search across skill catalog */
  search(query: string, domain?: string, checker?: ServerChecker): SkillMatch[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results: SkillMatch[] = [];

    for (const skill of this.skills.values()) {
      if (domain && skill.domain !== domain) continue;

      let score = 0;
      const nameLower = skill.name.toLowerCase();
      const descLower = skill.description.toLowerCase();

      for (const word of words) {
        if (nameLower === word) score += 10;
        else if (nameLower.includes(word)) score += 5;
        if (descLower.includes(word)) score += 2;
        if (skill.domain?.toLowerCase().includes(word)) score += 3;
      }

      if (score === 0) continue;

      const mcpStatus = this.checkMcpReadiness(skill, checker);
      const mcpReady = skill.requiresMcp.length === 0 ||
        Object.values(mcpStatus).every(s => s.available);

      results.push({ ...skill, score, mcpReady, mcpStatus });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /** Pre-flight check for a specific skill */
  advise(skillName: string, checker?: ServerChecker): SkillAdvice | null {
    const skill = this.skills.get(skillName);
    if (!skill) return null;

    const mcpStatus = this.checkMcpReadiness(skill, checker);
    const ready = skill.requiresMcp.length === 0 ||
      Object.values(mcpStatus).every(s => s.available);

    const recommendations: string[] = [];
    for (const [server, status] of Object.entries(mcpStatus)) {
      if (!status.available) {
        recommendations.push(`Provision "${server}" first via mcp_provision or: metamcp add ${server}`);
      }
    }

    return {
      skill: skill.name,
      domain: skill.domain,
      archetype: skill.archetype,
      ready,
      mcpStatus,
      recommendations,
    };
  }

  /** Get all skills that require a given MCP server */
  getSkillsForServer(serverName: string): SkillEntry[] {
    return [...this.skills.values()].filter(s => s.requiresMcp.includes(serverName));
  }

  /** Get skill by name */
  get(name: string): SkillEntry | undefined {
    return this.skills.get(name);
  }

  /** Get all skills */
  all(): SkillEntry[] {
    return [...this.skills.values()];
  }

  get size(): number {
    return this.skills.size;
  }

  private checkMcpReadiness(
    skill: SkillEntry,
    checker?: ServerChecker,
  ): Record<string, { available: boolean; state: string }> {
    const status: Record<string, { available: boolean; state: string }> = {};
    for (const server of skill.requiresMcp) {
      if (checker) {
        status[server] = checker(server);
      } else {
        status[server] = { available: false, state: 'unknown' };
      }
    }
    return status;
  }
}
