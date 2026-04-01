/**
 * metamcp init — Auto-configure MetaMCP as MCP server across all supported clients.
 *
 * Discovers the binary path, writes config to 9+ client locations,
 * returns structured JSON for programmatic consumption.
 *
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --- Types ---

export interface InitResult {
  success: boolean;
  binaryPath: string;
  configuredClients: Array<{ client: string; path: string; status: 'added' | 'created' }>;
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

interface InitOptions {
  yes: boolean;
  json: boolean;
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
    const result = execSync('which metamcp', { encoding: 'utf-8', timeout: 5_000 }).trim();
    if (result && existsSync(result)) return result;
  } catch {
    // not in PATH
  }

  return null;
}

// --- Config Targets ---

function getConfigTargets(): ConfigTarget[] {
  const home = homedir();
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
    backupFile(filePath);
    try {
      existing = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      status = 'added';
    } catch {
      // Invalid JSON — overwrite with fresh config
      existing = null;
    }
  }

  const config = existing ?? {};
  const servers = (config[serverKey] as Record<string, unknown>) ?? {};
  servers['metamcp'] = entry;
  config[serverKey] = servers;

  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
    backupFile(filePath);
    try {
      existing = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      status = 'added';
    } catch {
      existing = null;
    }
  }

  const config = existing ?? {};
  const contextServers = (config['context_servers'] as Record<string, unknown>) ?? {};
  contextServers['metamcp'] = buildZedEntry(binaryPath);
  config['context_servers'] = contextServers;

  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
    backupFile(filePath);
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
  lines.push(`args = ["${binaryPath}"]`);
  lines.push('');

  writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return status;
}

// --- Main ---

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const result: InitResult = {
    success: false,
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
  const targets = getConfigTargets();
  const entry = buildServerEntry(binaryPath);
  const seen = new Set<string>();

  for (const target of targets) {
    // Deduplicate by client name (e.g. Codex has two candidate paths)
    if (seen.has(target.client)) continue;

    try {
      let status: 'added' | 'created';

      switch (target.format) {
        case 'toml': {
          // Only write TOML if file already exists or parent dir exists
          if (!existsSync(target.path) && !existsSync(dirname(target.path))) {
            continue; // Skip non-existent Codex configs
          }
          status = writeTomlConfig(target, binaryPath);
          break;
        }
        case 'zed': {
          // Only write Zed config if settings.json already exists
          if (!existsSync(target.path)) continue;
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

  result.success = result.configuredClients.length > 0;

  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    const ok = result.configuredClients.length;
    const fail = result.failedClients.length;
    process.stderr.write(`\nDone: ${ok} configured, ${fail} failed\n`);
  }

  return result;
}

// --- CLI entrypoint (when run directly as `metamcp-init` or `node dist/init.js`) ---
const isDirectRun = process.argv[1]?.endsWith('/init.js') || process.argv[1]?.endsWith('/init.ts');
if (isDirectRun) {
  await runInit({
    yes: process.argv.includes('--yes'),
    json: process.argv.includes('--json'),
  });
  process.exit(0);
}
