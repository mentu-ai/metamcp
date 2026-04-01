import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { ChildManager } from './child-manager.js';
import { IntentRouter } from './intent.js';
import { TrustPolicy } from './trust.js';
import { log } from './log.js';
import { execute as sandboxExecute } from './sandbox.js';
import { recordLedger } from './ledger.js';
import { VectorStore } from './vector-store.js';
import { Embedder } from './embedder.js';
import type { ServerConfig } from './types.js';

// --- CLI argument parsing ---

interface CliOptions {
  configPath?: string;
  maxConnections: number;
  idleTimeout: number;
  failureThreshold: number;
  cooldown: number;
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

Commands:
  init                       Auto-configure MetaMCP in all supported MCP clients
    --yes                    Non-interactive mode (skip confirmation prompts)
    --json                   Output structured JSON result

Options:
  --config <path>            Path to .mcp.json (default: .mcp.json)
  --max-connections <n>      Pool max connections (default: 20)
  --idle-timeout <ms>        Idle connection timeout in ms (default: 300000)
  --failure-threshold <n>    Circuit breaker consecutive failures (default: 5)
  --cooldown <ms>            Circuit breaker cooldown in ms (default: 30000)
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
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'mcp_discover':
      return handleDiscover(args);
    case 'mcp_provision':
      return handleProvision(args);
    case 'mcp_call':
      return handleCall(args);
    case 'mcp_execute':
      return handleExecute(args);
    default:
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
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
