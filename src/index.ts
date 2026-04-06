import { readFileSync, watch, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { discoverExternalServers } from './config-imports.js';
import { ChildManager } from './child-manager.js';
import { IntentRouter } from './intent.js';
import { TrustPolicy } from './trust.js';
import { log } from './log.js';
import { execute as sandboxExecute } from './sandbox.js';
import { recordLedger } from './ledger.js';
import { VectorStore } from './vector-store.js';
import { Embedder } from './embedder.js';
import type { ServerConfig } from './types.js';
import { SkillCatalog } from './skill-catalog.js';
import { scrubSecrets } from './secret-scrubber.js';

// --- CLI argument parsing ---

interface CliOptions {
  configPath?: string;
  maxConnections: number;
  idleTimeout: number;
  failureThreshold: number;
  cooldown: number;
  importEditors: boolean;
}

function readPackageVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  const help = `metamcp — Meta-MCP server, OS for MCP servers

Usage: metamcp [options]
       metamcp init [--yes] [--json]
       metamcp add <server> [<server>...] [--config <path>]
       metamcp add --list [--category <name>] [--json]

Commands:
  init                       Auto-configure MetaMCP in all supported MCP clients
    --yes                    Non-interactive mode (skip confirmation prompts)
    --json                   Output structured JSON result
  add <server>               Add server(s) from the gallery to .mcp.json
    --list, -l               List all available servers
    --category <name>        Filter by category
    --config <path>          Target config file (default: .mcp.json)
    --json                   Output structured JSON

Options:
  --config <path>            Path to .mcp.json (default: .mcp.json)
  --max-connections <n>      Pool max connections (default: 20)
  --idle-timeout <ms>        Idle connection timeout in ms (default: 300000)
  --failure-threshold <n>    Circuit breaker consecutive failures (default: 5)
  --cooldown <ms>            Circuit breaker cooldown in ms (default: 30000)
  --import                   Auto-discover servers from installed editors
  --help                     Show this help message
  --version                  Show version number
`;
  process.stderr.write(help);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    maxConnections: 20,
    idleTimeout: 300_000,
    failureThreshold: 5,
    cooldown: 30_000,
    importEditors: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--version':
        process.stderr.write(readPackageVersion() + '\n');
        process.exit(0);
        break;
      case '--config':
        opts.configPath = argv[++i];
        break;
      case '--max-connections':
        opts.maxConnections = Number(argv[++i]);
        break;
      case '--idle-timeout':
        opts.idleTimeout = Number(argv[++i]);
        break;
      case '--failure-threshold':
        opts.failureThreshold = Number(argv[++i]);
        break;
      case '--cooldown':
        opts.cooldown = Number(argv[++i]);
        break;
      case '--import':
        opts.importEditors = true;
        break;
      default:
        process.stderr.write(`Unknown option: ${arg}\n`);
        printHelp();
        process.exit(1);
    }
  }

  return opts;
}

// --- Subcommand: init ---
if (process.argv[2] === 'init') {
  const { runInit } = await import('./init.js');
  await runInit({
    yes: process.argv.includes('--yes'),
    json: process.argv.includes('--json'),
  });
  process.exit(0);
}

// --- Subcommand: add ---
if (process.argv[2] === 'add') {
  const { runGalleryAdd } = await import('./gallery.js');
  await runGalleryAdd(process.argv.slice(3));
  process.exit(0);
}

const cliOptions = parseArgs(process.argv);

let vectorStore: VectorStore | undefined;
try {
  vectorStore = new VectorStore();
} catch (err) {
  log('warn', 'vector store unavailable — semantic search disabled', {
    error: err instanceof Error ? err.message : String(err),
  });
}

const embedder = new Embedder();

const server = new Server(
  { name: 'metamcp', version: readPackageVersion() },
  { capabilities: { tools: {} } }
);

const childManager = new ChildManager(
  {
    poolSize: cliOptions.maxConnections,
    resPoolSize: 0,
    idleTimeoutMs: cliOptions.idleTimeout,
    failureThreshold: cliOptions.failureThreshold,
    cooldownMs: cliOptions.cooldown,
  },
  { vectorStore, embedder },
);
const intentRouter = new IntentRouter();
const trustPolicy = new TrustPolicy();
const skillCatalog = new SkillCatalog();
let serverConfigs: ServerConfig[] = [];


server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'mcp_discover',
        description: 'Search tool catalogs across all child MCP servers + list server status. If no query, returns server list with status and tool counts.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search query for tools' },
            server: { type: 'string', description: 'Filter to a specific server' },
          },
        },
      },
      {
        name: 'mcp_provision',
        description: 'Intent-based provisioning. Describe what you need, MetaMCP resolves and provisions the right server.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            intent: { type: 'string', description: 'What capability you need' },
            context: { type: 'string', description: 'Additional context for resolution' },
            autoProvision: { type: 'boolean', description: 'Auto-provision if trusted (default: false)' },
          },
          required: ['intent'],
        },
      },
      {
        name: 'mcp_call',
        description: 'Forward a tool call to a specific child MCP server. Retries once on crash.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            server: { type: 'string', description: 'Target server name' },
            tool: { type: 'string', description: 'Tool name to call' },
            args: { type: 'object', description: 'Arguments to pass to the tool' },
          },
          required: ['server', 'tool'],
        },
      },
      {
        name: 'mcp_execute',
        description: 'Code-mode execution in V8 sandbox. Access provisioned servers via `servers.<name>.call(tool, args)`. Supports async/await, sleep(ms), console.log.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            code: { type: 'string', description: 'Code to execute' },
          },
          required: ['code'],
        },
      },
      {
        name: 'mcp_skill_discover',
        description: 'Search Claude Code skills with MCP readiness status. Returns skills matching query with their required MCP servers and availability.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search query for skills' },
            domain: { type: 'string', description: 'Filter by domain (e.g. browser_automation, monitoring)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'mcp_skill_advise',
        description: 'Pre-flight readiness check for a skill. Returns MCP server availability and recommendations.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            skill: { type: 'string', description: 'Skill name to check' },
          },
          required: ['skill'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const result = await (async () => {
    switch (name) {
      case 'mcp_discover':
        return handleDiscover(args);
      case 'mcp_provision':
        return handleProvision(args);
      case 'mcp_call':
        return handleCall(args);
      case 'mcp_execute':
        return handleExecute(args);
      case 'mcp_skill_discover':
        return handleSkillDiscover(args);
      case 'mcp_skill_advise':
        return handleSkillAdvise(args);
      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  })();

  // Scrub known secret patterns from any text content before it leaves the process.
  // This is the chokepoint — every tool response passes through here.
  if (result && Array.isArray((result as { content?: unknown[] }).content)) {
    const r = result as { content: Array<{ type: string; text?: string } & Record<string, unknown>> };
    r.content = r.content.map(c =>
      c.type === 'text' && typeof c.text === 'string'
        ? { ...c, text: scrubSecrets(c.text) }
        : c
    );
  }
  return result;
});

async function handleDiscover(args?: Record<string, unknown>) {
  const query = args?.query as string | undefined;
  const serverFilter = args?.server as string | undefined;

  // Lazy spawn: ensure all configured servers are connected
  await ensureAllConnected();

  if (!query) {
    // Return server list with status and tool counts
    const states = childManager.getAllStates();
    const result = states.map(s => ({
      name: s.name,
      state: s.state,
      toolCount: s.toolCount,
      criticality: s.criticality,
    }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }

  const catalog = childManager.getCatalog();
  const matches = await catalog.search(query, serverFilter);
  const result = matches.map(m => ({
    tool: m.tool.name,
    server: m.tool.server,
    description: m.tool.description,
    score: m.score,
    confidence: Math.round(m.confidence * 100) / 100,
  }));

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

async function handleProvision(args?: Record<string, unknown>) {
  const intent = args?.intent as string;
  const context = args?.context as string | undefined;
  const autoProvision = (args?.autoProvision as boolean) ?? false;

  if (!intent) {
    return {
      content: [{ type: 'text' as const, text: 'Missing required parameter: intent' }],
      isError: true,
    };
  }

  // Ensure connected for local catalog search
  await ensureAllConnected();

  const catalog = childManager.getCatalog();
  const result = await intentRouter.resolve(intent, catalog, context);

  // If local matches found, return them
  if (result.source === 'local' || result.localMatches.length > 0) {
    const tools = result.localMatches.map(m => ({
      tool: m.tool.name,
      server: m.tool.server,
      description: m.tool.description,
      confidence: Math.round(m.confidence * 100) / 100,
    }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ source: 'local', tools }, null, 2) }],
    };
  }

  // Registry matches — check trust for auto-provisioning
  if (result.registryMatches.length > 0) {
    const matches = result.registryMatches.map(entry => {
      const confidence = computeRegistryConfidence(intent, entry.name, entry.description);

      if (autoProvision) {
        const decision = trustPolicy.evaluate(entry.name, confidence);
        return {
          name: entry.name,
          description: entry.description,
          confidence: Math.round(confidence * 100) / 100,
          trusted: decision.trusted,
          autoProvisionable: decision.decision === 'allow',
          installCommand: `npx -y ${entry.name}`,
        };
      }

      log('info', 'provision available', {
        package: entry.name,
        installCommand: `npx -y ${entry.name}`,
      });

      return {
        name: entry.name,
        description: entry.description,
        confidence: Math.round(confidence * 100) / 100,
        installCommand: `npx -y ${entry.name}`,
      };
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ source: 'registry', matches }, null, 2),
      }],
    };
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ source: 'none', message: 'No matching servers found' }, null, 2),
    }],
  };
}

async function handleCall(args?: Record<string, unknown>) {
  const serverName = args?.server as string;
  const toolName = args?.tool as string;
  const toolArgs = args?.args as Record<string, unknown> | undefined;

  if (!serverName || !toolName) {
    return {
      content: [{ type: 'text' as const, text: 'Missing required parameters: server, tool' }],
      isError: true,
    };
  }

  // Check if server is configured
  if (!childManager.hasServer(serverName)) {
    // Try to find and spawn it from config
    const config = serverConfigs.find(c => c.name === serverName);
    if (config) {
      try {
        await childManager.spawn(config);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to connect to server ${serverName}: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    } else {
      return {
        content: [{ type: 'text' as const, text: `Unknown server: ${serverName}` }],
        isError: true,
      };
    }
  }

  const startTime = Date.now();
  try {
    const result = await childManager.callTool(serverName, toolName, toolArgs);
    recordLedger({
      timestamp: new Date().toISOString(),
      tool: 'mcp_call',
      server: serverName,
      childTool: toolName,
      duration_ms: Date.now() - startTime,
      success: true,
    });
    // Return result verbatim
    if (typeof result === 'object' && result !== null && 'content' in result) {
      return result as { content: Array<{ type: 'text'; text: string }> };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    recordLedger({
      timestamp: new Date().toISOString(),
      tool: 'mcp_call',
      server: serverName,
      childTool: toolName,
      duration_ms: Date.now() - startTime,
      success: false,
      error: errorMsg,
    });
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling ${toolName} on ${serverName}: ${errorMsg}`,
      }],
      isError: true,
    };
  }
}

async function handleExecute(args?: Record<string, unknown>) {
  const code = args?.code as string;
  if (!code) {
    return {
      content: [{ type: 'text' as const, text: 'Missing required parameter: code' }],
      isError: true,
    };
  }

  await ensureAllConnected();
  const catalog = childManager.getCatalog();

  const startTime = Date.now();
  try {
    const result = await sandboxExecute(code, childManager, catalog);
    recordLedger({
      timestamp: new Date().toISOString(),
      tool: 'mcp_execute',
      server: null,
      duration_ms: Date.now() - startTime,
      success: true,
    });
    const parts: string[] = [];
    if (result.console.length > 0) {
      parts.push(result.console.join('\n'));
    }
    if (result.value !== undefined) {
      parts.push(typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2));
    }
    return {
      content: [{ type: 'text' as const, text: parts.join('\n') || '(no output)' }],
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    recordLedger({
      timestamp: new Date().toISOString(),
      tool: 'mcp_execute',
      server: null,
      duration_ms: Date.now() - startTime,
      success: false,
      error: errorMsg,
    });
    return {
      content: [{
        type: 'text' as const,
        text: `mcp_execute error: ${errorMsg}`,
      }],
      isError: true,
    };
  }
}

function serverChecker(serverName: string): { available: boolean; state: string } {
  if (childManager.hasServer(serverName)) {
    return { available: true, state: 'connected' };
  }
  const configured = serverConfigs.some(c => c.name === serverName);
  return {
    available: false,
    state: configured ? 'configured_not_spawned' : 'not_configured',
  };
}

async function handleSkillDiscover(args?: Record<string, unknown>) {
  const query = args?.query as string;
  const domain = args?.domain as string | undefined;

  if (!query) {
    // List all skills with readiness
    const all = skillCatalog.all().map(s => {
      const advice = skillCatalog.advise(s.name, serverChecker);
      return {
        skill: s.name,
        description: s.description,
        domain: s.domain,
        archetype: s.archetype,
        requiresMcp: s.requiresMcp,
        mcpReady: advice?.ready ?? false,
        source: s.source,
      };
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(all, null, 2) }],
    };
  }

  const matches = skillCatalog.search(query, domain, serverChecker);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(matches.map(m => ({
      skill: m.name,
      description: m.description,
      domain: m.domain,
      archetype: m.archetype,
      score: m.score,
      mcpReady: m.mcpReady,
      requiresMcp: m.requiresMcp,
      mcpStatus: m.mcpStatus,
      source: m.source,
    })), null, 2) }],
  };
}

async function handleSkillAdvise(args?: Record<string, unknown>) {
  const skillName = args?.skill as string;
  if (!skillName) {
    return {
      content: [{ type: 'text' as const, text: 'Missing required parameter: skill' }],
      isError: true,
    };
  }

  const advice = skillCatalog.advise(skillName, serverChecker);
  if (!advice) {
    // Check if any gallery server matches — suggest installing
    const { GALLERY } = await import('./gallery.js');
    const galleryMatch = GALLERY.find(g =>
      g.name.toLowerCase().includes(skillName.toLowerCase()) ||
      skillName.toLowerCase().includes(g.name.toLowerCase().replace(/^@[^/]+\//, '').replace(/^(mcp-server-|server-)/, ''))
    );

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        skill: skillName,
        ready: false,
        error: 'Skill not found',
        suggestion: galleryMatch
          ? `No skill "${skillName}" found, but there's an MCP server available: ${galleryMatch.name}. Install with: metamcp add ${skillName}`
          : `No skill "${skillName}" found. Check ~/.claude/skills/ or .claude/skills/`,
      }, null, 2) }],
    };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(advice, null, 2) }],
  };
}

async function ensureAllConnected(): Promise<void> {
  for (const config of serverConfigs) {
    if (!childManager.hasServer(config.name)) {
      try {
        await childManager.spawn(config);
      } catch (err) {
        log('error', 'failed to spawn server', {
          server: config.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

function computeRegistryConfidence(intent: string, name: string, description: string): number {
  const words = intent.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  const nameLower = name.toLowerCase();
  const descLower = description.toLowerCase();
  let score = 0;

  for (const word of words) {
    if (nameLower === word) score += 10;
    else if (nameLower.includes(word)) score += 5;
    if (descLower.includes(word)) score += 2;
  }

  const maxPossible = words.length * 12;
  return maxPossible > 0 ? Math.min(score / maxPossible, 1) : 0;
}

async function main() {
  serverConfigs = loadConfig(cliOptions.configPath);

  // Auto-discover servers from installed editors when --import is set
  if (cliOptions.importEditors) {
    const discovered = discoverExternalServers(process.cwd());
    const localNames = new Set(serverConfigs.map(s => s.name));
    let importCount = 0;
    for (const [name, { config, source }] of discovered) {
      if (!localNames.has(name)) {
        serverConfigs.push(config);
        importCount++;
        log('info', 'imported server from editor config', { name, source });
      }
    }
    if (importCount > 0) {
      log('info', 'editor import complete', { imported: importCount, total: serverConfigs.length });
    }
  }

  log('info', 'config loaded', {
    serverCount: serverConfigs.length,
    maxConnections: cliOptions.maxConnections,
    idleTimeout: cliOptions.idleTimeout,
    failureThreshold: cliOptions.failureThreshold,
    cooldown: cliOptions.cooldown,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('info', 'server started', { transport: 'stdio' });

  // Hot-reload: watch .mcp.json for changes (e.g. from `metamcp add`)
  // Uses dual strategy: watch file directly when it exists, poll as fallback.
  const configPath = resolve(cliOptions.configPath ?? '.mcp.json');
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  let lastConfigMtime = 0;

  function reloadConfig(): void {
    try {
      if (!existsSync(configPath)) return;
      const fresh = loadConfig(cliOptions.configPath);
      const existing = new Set(serverConfigs.map(s => s.name));
      let added = 0;
      for (const cfg of fresh) {
        if (!existing.has(cfg.name)) {
          serverConfigs.push(cfg);
          added++;
          log('info', 'hot-reload: new server available', { name: cfg.name });
        }
      }
      if (added > 0) {
        log('info', 'hot-reload complete', { added, total: serverConfigs.length });
      }
    } catch {
      log('warn', 'hot-reload: failed to parse config');
    }
  }

  function scheduleReload(): void {
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(reloadConfig, 300);
  }

  // Strategy 1: fs.watch on the file (best latency, but only works if file exists)
  function watchFile(): void {
    try {
      if (!existsSync(configPath)) return;
      const watcher = watch(configPath, () => scheduleReload());
      // Re-create watcher if file is deleted and recreated
      watcher.on('error', () => { watcher.close(); });
      log('info', 'watching config for hot-reload', { path: configPath });
    } catch { /* non-fatal */ }
  }
  watchFile();

  // Strategy 2: lightweight poll every 2s to catch file creation and atomic renames
  // Checks mtime only — no disk read unless changed.
  const pollInterval = setInterval(() => {
    try {
      if (!existsSync(configPath)) {
        if (lastConfigMtime !== 0) lastConfigMtime = 0; // file was deleted
        return;
      }
      const { mtimeMs } = require('node:fs').statSync(configPath);
      if (mtimeMs !== lastConfigMtime) {
        if (lastConfigMtime === 0) watchFile(); // file just appeared — start watching
        lastConfigMtime = mtimeMs;
        scheduleReload();
      }
    } catch { /* non-fatal */ }
  }, 2000);
  pollInterval.unref(); // don't keep process alive

  let shuttingDown = false;
  async function gracefulShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await childManager.shutdownAll();
    vectorStore?.close();
    await server.close();
    process.exit(0);
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  process.stdin.on('end', () => {
    if (!shuttingDown) {
      log('info', 'stdin closed — parent disconnected, shutting down');
      gracefulShutdown();
    }
  });

  process.on('uncaughtException', (err) => {
    log('error', 'uncaught exception', { error: err.message });
    childManager.killAllSync();
    process.exit(1);
  });
}

main().catch(err => {
  log('error', 'fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
