/**
 * metamcp init - Preview or apply MetaMCP client configuration safely.
 *
 * Existing configs are detected by default; named clients may be targeted
 * explicitly. Writes require --yes and preserve a backup.
 *
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --- Types ---

export interface InitResult {
  success: boolean;
  applied: boolean;
  binaryPath: string;
  configuredClients: Array<{ client: string; path: string; status: 'planned' | 'added' | 'created' }>;
  failedClients: Array<{ client: string; path: string; error: string }>;
  errors: string[];
}

type ConfigFormat = 'json' | 'toml' | 'zed';

interface ConfigTarget {
  client: string;
  path: string;
  serverKey: string;
  format: ConfigFormat;
}

export interface InitOptions {
  yes: boolean;
  json: boolean;
  clients?: string[];
  homeDir?: string;
}

// --- Binary Discovery ---

/**
 * Discover the path to MetaMCP's index.js entry point.
 * 6-path fallback chain for locating the MetaMCP entry point.
 */
function discoverBinaryPath(): string | null {
  const home = homedir();
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = dirname(thisFile);

  const candidates = [
    // 1. Sibling index.js in same dist/ directory (most common: running from repo)
    join(distDir, 'index.js'),
    // 2. process.argv[1] if it points to index.js
    process.argv[1]?.endsWith('index.js') ? resolve(process.argv[1]) : null,
    // 3. Installed location
    join(home, '.metamcp', 'bin', 'metamcp'),
    // 4. Dev desktop path
    join(home, 'Desktop', 'metamcp', 'dist', 'index.js'),
    // 5. Homebrew
    '/opt/homebrew/bin/metamcp',
    // 6. Global npm
    '/usr/local/bin/metamcp',
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  // 7. which metamcp
  try {
    const result = execFileSync('which', ['metamcp'], { encoding: 'utf-8', timeout: 5_000 }).trim();
    if (result && existsSync(result)) return result;
  } catch {
    // not in PATH
  }

  return null;
}

// --- Config Targets ---

function getConfigTargets(home = homedir()): ConfigTarget[] {
  return [
    // Meta
    { client: 'Global', path: join(home, '.mcp.json'), serverKey: 'mcpServers', format: 'json' },
    // Anthropic
    { client: 'Claude Code', path: join(home, '.claude.json'), serverKey: 'mcpServers', format: 'json' },
    { client: 'Claude Desktop', path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), serverKey: 'mcpServers', format: 'json' },
    // Editors
    { client: 'Cursor', path: join(home, '.cursor', 'mcp.json'), serverKey: 'mcpServers', format: 'json' },
    { client: 'VS Code', path: join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'), serverKey: 'servers', format: 'json' },
    { client: 'Windsurf', path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), serverKey: 'mcpServers', format: 'json' },
    { client: 'Zed', path: join(home, 'Library', 'Application Support', 'Zed', 'settings.json'), serverKey: 'context_servers', format: 'zed' },
    // CLI agents
    { client: 'Gemini CLI', path: join(home, '.gemini', 'settings.json'), serverKey: 'mcpServers', format: 'json' },
    { client: 'GitHub Copilot CLI', path: join(home, '.copilot', 'mcp-config.json'), serverKey: 'mcpServers', format: 'json' },
    // TOML
    { client: 'Codex', path: join(home, '.codex', 'config.toml'), serverKey: 'mcp_servers', format: 'toml' },
    { client: 'Codex (XDG)', path: join(home, '.config', 'codex', 'config.toml'), serverKey: 'mcp_servers', format: 'toml' },
  ];
}

// --- Config Writers ---

function buildServerEntry(binaryPath: string): Record<string, unknown> {
  return {
    command: 'node',
    args: [binaryPath],
  };
}

function buildZedEntry(binaryPath: string): Record<string, unknown> {
  return {
    command: { path: 'node', args: [binaryPath] },
    settings: {},
  };
}

/**
 * Backup an existing file to .bak before overwriting.
 */
function backupFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const backupPath = filePath + '.bak';
  copyFileSync(filePath, backupPath);
}

function writeAtomic(filePath: string, content: string): void {
  const temporary = join(dirname(filePath), `.${basename(filePath)}.metamcp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf-8', mode: 0o600 });
    renameSync(temporary, filePath);
  } catch (err) {
    try { unlinkSync(temporary); } catch { /* no temporary file to remove */ }
    throw err;
  }
}

function readJsonObject(filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Refusing to replace invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Refusing to replace invalid JSON in ${filePath}: top-level value must be an object`);
  }
  return parsed;
}

function readObjectSection(config: Record<string, unknown>, key: string, filePath: string): Record<string, unknown> {
  const section = config[key];
  if (section === undefined) return {};
  if (!isRecord(section)) {
    throw new Error(`Refusing to replace invalid JSON in ${filePath}: ${key} must be an object`);
  }
  return section;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePreviewTarget(target: ConfigTarget): void {
  if (!existsSync(target.path) || target.format === 'toml') return;
  const config = readJsonObject(target.path);
  readObjectSection(config, target.serverKey, target.path);
}

/**
 * Write or merge a JSON config file. Returns 'added' if existing file was updated,
 * 'created' if a new file was written.
 */
function writeJsonConfig(
  target: ConfigTarget,
  entry: Record<string, unknown>,
): 'added' | 'created' {
  const { path: filePath, serverKey } = target;
  const dir = dirname(filePath);

  // Ensure parent directory exists
  mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> | null = null;
  let status: 'added' | 'created' = 'created';

  if (existsSync(filePath)) {
    existing = readJsonObject(filePath);
    status = 'added';
  }

  const config = existing ?? {};
  const servers = readObjectSection(config, serverKey, filePath);
  servers['metamcp'] = entry;
  config[serverKey] = servers;

  backupFile(filePath);
  writeAtomic(filePath, JSON.stringify(config, null, 2) + '\n');
  return status;
}

/**
 * Write Zed settings.json config. Zed uses a nested format under context_servers.
 * Must preserve all other settings.
 */
function writeZedConfig(
  target: ConfigTarget,
  binaryPath: string,
): 'added' | 'created' {
  const { path: filePath } = target;
  const dir = dirname(filePath);

  mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> | null = null;
  let status: 'added' | 'created' = 'created';

  if (existsSync(filePath)) {
    existing = readJsonObject(filePath);
    status = 'added';
  }

  const config = existing ?? {};
  const contextServers = readObjectSection(config, 'context_servers', filePath);
  contextServers['metamcp'] = buildZedEntry(binaryPath);
  config['context_servers'] = contextServers;

  backupFile(filePath);
  writeAtomic(filePath, JSON.stringify(config, null, 2) + '\n');
  return status;
}

/**
 * Write or merge a TOML config file for Codex CLI.
 * Appends/replaces the [mcp_servers.metamcp] block.
 */
function writeTomlConfig(
  target: ConfigTarget,
  binaryPath: string,
): 'added' | 'created' {
  const { path: filePath } = target;
  const dir = dirname(filePath);

  mkdirSync(dir, { recursive: true });

  let status: 'added' | 'created' = 'created';
  let lines: string[] = [];

  if (existsSync(filePath)) {
    status = 'added';
    const content = readFileSync(filePath, 'utf-8');

    // Remove any previous [mcp_servers.metamcp] block
    let skip = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '[mcp_servers.metamcp]') {
        skip = true;
        continue;
      }
      if (skip && trimmed.startsWith('[')) {
        skip = false;
      }
      if (!skip) lines.push(line);
    }
    // Remove trailing blank lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
  }

  // Append metamcp server block
  lines.push('');
  lines.push('[mcp_servers.metamcp]');
  lines.push(`command = "node"`);
  lines.push(`args = [${JSON.stringify(binaryPath)}]`);
  lines.push('');

  backupFile(filePath);
  writeAtomic(filePath, lines.join('\n'));
  return status;
}

// --- Main ---

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const result: InitResult = {
    success: false,
    applied: opts.yes,
    binaryPath: '',
    configuredClients: [],
    failedClients: [],
    errors: [],
  };

  // 1. Discover binary path
  const binaryPath = discoverBinaryPath();
  if (!binaryPath) {
    result.errors.push('Could not discover MetaMCP binary path');
    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      process.stderr.write('Error: Could not discover MetaMCP binary path\n');
    }
    return result;
  }
  result.binaryPath = binaryPath;

  if (!opts.json) {
    process.stderr.write(`Binary: ${binaryPath}\n`);
  }

  // 2. Configure each target
  const targets = getConfigTargets(opts.homeDir);
  const entry = buildServerEntry(binaryPath);
  const seen = new Set<string>();
  const requestedClients = new Set((opts.clients ?? []).map(client => client.toLowerCase()));

  for (const target of targets) {
    // Deduplicate by client name (e.g. Codex has two candidate paths)
    if (seen.has(target.client)) continue;
    if (requestedClients.size > 0 && !requestedClients.has(target.client.toLowerCase())) continue;
    if (requestedClients.size === 0 && !existsSync(target.path)) continue;

    try {
      if (!opts.yes) {
        validatePreviewTarget(target);
        seen.add(target.client);
        result.configuredClients.push({ client: target.client, path: target.path, status: 'planned' });
        if (!opts.json) process.stderr.write(`  ~ ${target.client}: ${target.path} (planned)\n`);
        continue;
      }
      let status: 'added' | 'created';

      switch (target.format) {
        case 'toml': {
          status = writeTomlConfig(target, binaryPath);
          break;
        }
        case 'zed': {
          status = writeZedConfig(target, binaryPath);
          break;
        }
        default: {
          status = writeJsonConfig(target, entry);
          break;
        }
      }

      seen.add(target.client);
      result.configuredClients.push({ client: target.client, path: target.path, status });

      if (!opts.json) {
        const symbol = status === 'added' ? 'updated' : 'created';
        process.stderr.write(`  + ${target.client}: ${target.path} (${symbol})\n`);
      }
    } catch (err) {
      seen.add(target.client);
      const message = err instanceof Error ? err.message : String(err);
      result.failedClients.push({ client: target.client, path: target.path, error: message });

      if (!opts.json) {
        process.stderr.write(`  x ${target.client}: ${message}\n`);
      }
    }
  }

  for (const requested of requestedClients) {
    const matched = Array.from(seen).some(client => client.toLowerCase() === requested);
    if (!matched) result.errors.push(`Unknown or unavailable client: ${requested}`);
  }

  result.success = result.configuredClients.length > 0
    && result.failedClients.length === 0
    && result.errors.length === 0;

  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    const ok = result.configuredClients.length;
    const fail = result.failedClients.length;
    process.stderr.write(opts.yes
      ? `\nDone: ${ok} configured, ${fail} failed\n`
      : `\nPreview: ${ok} client config(s), ${fail} invalid. Re-run with --yes to apply.\n`);
  }

  return result;
}

// --- CLI entrypoint (when run directly as `metamcp-init` or `node dist/init.js`) ---
const isDirectRun = process.argv[1]?.endsWith('/init.js') || process.argv[1]?.endsWith('/init.ts');
if (isDirectRun) {
  const result = await runInit({
    yes: process.argv.includes('--yes'),
    json: process.argv.includes('--json'),
    clients: collectOptionValues(process.argv.slice(2), '--client'),
  });
  process.exit(result.success ? 0 : 1);
}

function collectOptionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1]) values.push(args[++index]);
  }
  return values;
}
