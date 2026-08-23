import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, watch, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DualEraServerTransport, SUPPORTED_MODERN_PROTOCOL_VERSIONS } from './dual-era.js';
import {
  resolveGatewayAuth,
  createGatewayVerifier,
  gatewayMetadataPath,
  gatewayMetadataDocument,
  authorizeGatewayRequest,
  type GatewayAuthEnv,
} from './gateway-auth.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { discoverExternalServers } from './config-imports.js';
import { ChildManager } from './child-manager.js';
import { log } from './log.js';
import { recordLedger } from './ledger.js';
import type { VectorStore } from './vector-store.js';
import { AnthropicEmbedderProvider, Embedder } from './embedder.js';
import type { ServerConfig } from './types.js';
import { registerSecretValues, scrubSecrets, scrubValue } from './secret-scrubber.js';
import { MethodRegistry, MethodRunner } from './methods.js';

// --- CLI argument parsing ---

interface CliOptions {
  configPath?: string;
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  httpPath: string;
  maxConnections: number;
  idleTimeout: number;
  failureThreshold: number;
  cooldown: number;
  importEditors: boolean;
  methodsDir: string;
  allowWrites: boolean;
  allowedOrigins: string[];
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
  const help = `metamcp - Meta-MCP server, OS for MCP servers

Usage: metamcp [options]
       metamcp init [--yes] [--client <name>] [--json]
       metamcp add <server> [<server>...] [--config <path>]
       metamcp add --list [--category <name>] [--json]

Commands:
  init                       Preview setup for detected MCP clients
    --yes                    Apply the previewed changes (writes backups atomically)
    --client <name>          Target one client; repeat to target several
    --json                   Output structured JSON result
  add <server>               Add server(s) from the gallery to .mcp.json
    --list, -l               List all available servers
    --category <name>        Filter by category
    --config <path>          Target config file (default: .mcp.json)
    --json                   Output structured JSON

Options:
  --config <path>            Path to .mcp.json (default: .mcp.json)
  --transport <stdio|http>   Inbound transport (default: stdio; env METAMCP_TRANSPORT)
  --host <host>              HTTP host when --transport http (default: 127.0.0.1)
  --port <port>              HTTP port when --transport http (default: env PORT or 8080)
  --http-path <path>         Streamable HTTP MCP path (default: /mcp)
  --max-connections <n>      Pool max connections (default: 20)
  --idle-timeout <ms>        Idle connection timeout in ms (default: 300000)
  --failure-threshold <n>    Circuit breaker consecutive failures (default: 5)
  --cooldown <ms>            Circuit breaker cooldown in ms (default: 30000)
  --import                   Auto-discover servers from installed editors
  --methods <directory>      Method manifests directory (default: .metamcp/methods)
  --allow-writes             Allow Methods declaring write or mixed effects
  --allow-origin <origin>    Allow an exact browser Origin in HTTP mode (repeatable)
  --help                     Show this help message
  --version                  Show version number
`;
  process.stderr.write(help);
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    configPath: process.env.METAMCP_CONFIG,
    transport: process.env.METAMCP_TRANSPORT === 'http' ? 'http' : 'stdio',
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? '8080'),
    httpPath: process.env.METAMCP_HTTP_PATH ?? '/mcp',
    maxConnections: 20,
    idleTimeout: 300_000,
    failureThreshold: 5,
    cooldown: 30_000,
    importEditors: false,
    methodsDir: process.env.METAMCP_METHODS_DIR ?? resolve(process.cwd(), '.metamcp', 'methods'),
    allowWrites: process.env.METAMCP_ALLOW_WRITES === '1',
    allowedOrigins: (process.env.METAMCP_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean),
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
        opts.configPath = requireOptionValue(argv, i, arg);
        i++;
        break;
      case '--transport': {
        const transport = requireOptionValue(argv, i, arg);
        i++;
        if (transport !== 'stdio' && transport !== 'http') {
          process.stderr.write(`Invalid transport: ${transport}\n`);
          process.exit(1);
        }
        opts.transport = transport;
        break;
      }
      case '--host':
        opts.host = requireOptionValue(argv, i, arg);
        i++;
        break;
      case '--port':
        opts.port = Number(requireOptionValue(argv, i, arg));
        i++;
        break;
      case '--http-path':
        opts.httpPath = normalizeHttpPath(requireOptionValue(argv, i, arg));
        i++;
        break;
      case '--max-connections':
        opts.maxConnections = Number(requireOptionValue(argv, i, arg));
        i++;
        break;
      case '--idle-timeout':
        opts.idleTimeout = Number(requireOptionValue(argv, i, arg));
        i++;
        break;
      case '--failure-threshold':
        opts.failureThreshold = Number(requireOptionValue(argv, i, arg));
        i++;
        break;
      case '--cooldown':
        opts.cooldown = Number(requireOptionValue(argv, i, arg));
        i++;
        break;
      case '--import':
        opts.importEditors = true;
        break;
      case '--methods':
        opts.methodsDir = requireOptionValue(argv, i, arg);
        i++;
        break;
      case '--allow-writes':
        opts.allowWrites = true;
        break;
      case '--allow-origin':
        opts.allowedOrigins.push(requireOptionValue(argv, i, arg));
        i++;
        break;
      default:
        process.stderr.write(`Unknown option: ${arg}\n`);
        printHelp();
        process.exit(1);
    }
  }

  if (!opts.configPath && process.env.METAMCP_CONFIG === '') opts.configPath = undefined;
  if (!opts.methodsDir) throw new Error('--methods requires a directory');
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  if (!Number.isInteger(opts.maxConnections) || opts.maxConnections < 1 || opts.maxConnections > 1024) {
    throw new Error('--max-connections must be an integer from 1 to 1024');
  }
  if (!Number.isInteger(opts.idleTimeout) || opts.idleTimeout < 1) {
    throw new Error('--idle-timeout must be a positive integer');
  }
  if (!Number.isInteger(opts.failureThreshold) || opts.failureThreshold < 1) {
    throw new Error('--failure-threshold must be a positive integer');
  }
  if (!Number.isInteger(opts.cooldown) || opts.cooldown < 0) {
    throw new Error('--cooldown must be a non-negative integer');
  }
  if (!opts.host.trim()) {
    throw new Error('--host must be non-empty');
  }
  for (const origin of opts.allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid allowed Origin: ${origin}`);
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== origin) {
      throw new Error(`Allowed Origin must be an exact http(s) origin without a path: ${origin}`);
    }
  }

  return opts;
}

function requireOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function normalizeHttpPath(path: string): string {
  if (!path) return '/mcp';
  return path.startsWith('/') ? path : `/${path}`;
}

function parseInitOptions(args: string[]): { yes: boolean; json: boolean; clients: string[] } {
  const options = { yes: false, json: false, clients: [] as string[] };
  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case '--yes':
        options.yes = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--client':
        options.clients.push(requireOptionValue(args, index, '--client'));
        index++;
        break;
      default:
        throw new Error(`Unknown init option: ${args[index]}`);
    }
  }
  return options;
}

// --- Subcommand: init ---
if (process.argv[2] === 'init') {
  const { runInit } = await import('./init.js');
  let options: ReturnType<typeof parseInitOptions>;
  try {
    options = parseInitOptions(process.argv.slice(3));
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const result = await runInit(options);
  process.exit(result.success ? 0 : 1);
}

// --- Subcommand: add ---
if (process.argv[2] === 'add') {
  const { runGalleryAdd } = await import('./gallery.js');
  try {
    const success = await runGalleryAdd(process.argv.slice(3));
    process.exit(success ? 0 : 1);
  } catch (err) {
    process.stderr.write(`Error: ${errorMessage(err)}\n`);
    process.exit(1);
  }
}

// --- Subcommand: export-evidence ---
if (process.argv[2] === 'export-evidence') {
  const { runEvidenceExportCli } = await import('./evidence-export.js');
  await runEvidenceExportCli(process.argv.slice(3));
  process.exit(0);
}

const cliOptions = (() => {
  try {
    return parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
})();

let vectorStore: VectorStore | undefined;
let embedder: Embedder | undefined;
const embeddingKey = process.env.METAMCP_VOYAGE_API_KEY;
if (embeddingKey) {
  registerSecretValues([embeddingKey]);
  try {
    const { VectorStore: LoadedVectorStore } = await import('./vector-store.js');
    vectorStore = new LoadedVectorStore();
    embedder = new Embedder(new AnthropicEmbedderProvider(embeddingKey));
  } catch (err) {
    log('warn', 'semantic search unavailable - continuing with local keyword search', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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
let serverConfigs: ServerConfig[] = [];
const methodRegistry = new MethodRegistry(cliOptions.methodsDir);
const methodRunner = new MethodRunner(
  methodRegistry,
  (server, tool, args, options) => callConfiguredChild(server, tool, args, options.timeoutMs),
  cliOptions.allowWrites,
);
const stdioServer = createMetaMcpServer();

function createMetaMcpServer(): Server {
  const server = new Server(
    { name: 'metamcp', version: readPackageVersion() },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'mcp_discover',
          description: 'Search configured servers, cached child tool schemas, and declarative Methods without starting every child. Set refresh=true with a specific server to refresh only that server.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Capability search query' },
              kind: { type: 'string', enum: ['all', 'server', 'tool', 'method'], description: 'Result kind (default: all)' },
              server: { type: 'string', description: 'Filter child tools to one configured server' },
              refresh: { type: 'boolean', description: 'Connect to the named server and refresh its live schemas' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'mcp_call',
          description: 'Call one explicitly named child tool. The target starts lazily. Calls are never replayed implicitly after a timeout or transport failure.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              server: { type: 'string', description: 'Configured child server name' },
              tool: { type: 'string', description: 'Child tool name' },
              args: { type: 'object', description: 'Arguments passed to the child tool' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 600000, description: 'Optional per-call deadline' },
            },
            required: ['server', 'tool'],
            additionalProperties: false,
          },
        },
        {
          name: 'mcp_run',
          description: 'Run a reviewed declarative Method: a bounded, schema-validated sequence of lazy child calls with typed gaps and trace evidence.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              method: { type: 'string', description: 'Registered Method name' },
              input: { type: 'object', description: 'Method input validated against its JSON Schema' },
            },
            required: ['method', 'input'],
            additionalProperties: false,
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
      case 'mcp_call':
        return handleCall(args);
      case 'mcp_run':
        return handleRun(args);
      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  })();

    // Every text and structured field crosses one recursive redaction boundary.
    return scrubValue(result) as typeof result;
  });

  return server;
}

async function handleDiscover(args?: Record<string, unknown>) {
  const query = args?.query as string | undefined;
  const serverFilter = args?.server as string | undefined;
  const kind = (args?.kind as string | undefined) ?? 'all';
  const refresh = args?.refresh === true;

  if (!['all', 'server', 'tool', 'method'].includes(kind)) {
    return toolError('kind must be one of: all, server, tool, method');
  }
  if (serverFilter && !serverConfigs.some(config => config.name === serverFilter)) {
    return toolError(`Unknown server: ${serverFilter}`);
  }
  if (refresh && !serverFilter) {
    return toolError('refresh requires a specific server; MetaMCP never fans out implicitly');
  }
  if (refresh && serverFilter) {
    try {
      await refreshConfiguredChild(serverFilter);
    } catch (err) {
      return toolError(`Failed to refresh ${serverFilter}: ${errorMessage(err)}`);
    }
  }

  const catalog = childManager.getCatalog();
  const servers = kind === 'all' || kind === 'server'
    ? serverConfigs
      .filter(config => !serverFilter || config.name === serverFilter)
      .filter(config => !query || config.name.toLowerCase().includes(query.toLowerCase()))
      .map(config => {
        const live = childManager.getServerState(config.name);
        const cachedTools = catalog.getServerTools(config.name);
        const liveSchema = live?.state === 'idle' || live?.state === 'active';
        return {
          name: config.name,
          state: live?.state ?? 'configured',
          toolCount: live?.toolCount ?? cachedTools.length,
          schemaSource: liveSchema ? 'live' : cachedTools.length > 0 ? 'cache' : 'unknown',
          transport: config.transport ?? 'stdio',
        };
      })
    : [];
  const tools = (kind === 'all' || kind === 'tool') && query
    ? (await catalog.search(query, serverFilter)).map(match => ({
      tool: match.tool.name,
      server: match.tool.server,
      description: match.tool.description,
      confidence: Math.round(match.confidence * 100) / 100,
      schemaSource: ['idle', 'active'].includes(childManager.getServerState(match.tool.server)?.state ?? '') ? 'live' : 'cache',
    }))
    : [];
  const methods = kind === 'all' || kind === 'method'
    ? query ? methodRegistry.search(query) : methodRegistry.list()
    : [];
  const result = { servers, tools, methods };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

async function handleCall(args?: Record<string, unknown>) {
  const serverName = args?.server as string;
  const toolName = args?.tool as string;
  const toolArgs = args?.args as Record<string, unknown> | undefined;
  const timeoutMs = args?.timeoutMs as number | undefined;

  if (!serverName || !toolName) {
    return toolError('Missing required parameters: server, tool');
  }
  if (toolArgs !== undefined && (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs))) {
    return toolError('args must be an object');
  }
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)) {
    return toolError('timeoutMs must be an integer from 1 to 600000');
  }
  if (!serverConfigs.some(config => config.name === serverName)) {
    return toolError(`Unknown server: ${serverName}`);
  }

  const startTime = Date.now();
  try {
    const result = await callConfiguredChild(serverName, toolName, toolArgs, timeoutMs);
    const childReportedError = isRecord(result) && result.isError === true;
    await recordGatewayCall({
      tool: 'mcp_call',
      server: serverName,
      childTool: toolName,
      durationMs: Date.now() - startTime,
      success: !childReportedError,
      ...(childReportedError ? { error: 'Child tool returned an error result' } : {}),
    });
    if (typeof result === 'object' && result !== null && 'content' in result) {
      return result as { content: Array<{ type: 'text'; text: string }> };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const errorMsg = errorMessage(err);
    await recordGatewayCall({
      tool: 'mcp_call',
      server: serverName,
      childTool: toolName,
      durationMs: Date.now() - startTime,
      success: false,
      error: errorMsg,
    });
    return toolError(`Error calling ${toolName} on ${serverName}: ${errorMsg}`);
  }
}

async function handleRun(args?: Record<string, unknown>) {
  const method = args?.method as string | undefined;
  const input = args?.input;
  if (!method) return toolError('Missing required parameter: method');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return toolError('input must be an object');
  }

  const startTime = Date.now();
  try {
    const result = await methodRunner.run(method, input as Record<string, unknown>);
    await recordGatewayCall({
      tool: 'mcp_run',
      server: null,
      durationMs: Date.now() - startTime,
      success: true,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (err) {
    const errorMsg = errorMessage(err);
    await recordGatewayCall({
      tool: 'mcp_run',
      server: null,
      durationMs: Date.now() - startTime,
      success: false,
      error: errorMsg,
    });
    return toolError(`Method ${method} failed: ${errorMsg}`);
  }
}

async function connectConfiguredChild(serverName: string): Promise<void> {
  const config = serverConfigs.find(candidate => candidate.name === serverName);
  if (!config) throw new Error(`Unknown server: ${serverName}`);
  if (!childManager.hasServer(serverName)) {
    await childManager.spawn(config);
    return;
  }
  await childManager.ensureConnected(serverName);
}

async function refreshConfiguredChild(serverName: string): Promise<void> {
  const config = serverConfigs.find(candidate => candidate.name === serverName);
  if (!config) throw new Error(`Unknown server: ${serverName}`);
  if (!childManager.hasServer(serverName)) {
    await childManager.spawn(config);
    return;
  }
  await childManager.refreshSchemas(serverName);
}

async function callConfiguredChild(
  serverName: string,
  toolName: string,
  args?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  await connectConfiguredChild(serverName);
  return childManager.callTool(serverName, toolName, args, { timeoutMs });
}

function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordGatewayCall(entry: {
  tool: 'mcp_call' | 'mcp_run';
  server: string | null;
  childTool?: string;
  durationMs: number;
  success: boolean;
  error?: string;
}): Promise<void> {
  return recordLedger({
    timestamp: new Date().toISOString(),
    tool: entry.tool,
    server: entry.server,
    childTool: entry.childTool,
    duration_ms: entry.durationMs,
    success: entry.success,
    ...(entry.error ? { error: scrubSecrets(entry.error) } : {}),
  });
}

function configFingerprint(config: ServerConfig): string {
  return JSON.stringify(config);
}

function isSelfReference(config: ServerConfig): boolean {
  const command = config.command.toLowerCase().replaceAll('\\', '/');
  const args = (config.args ?? []).join(' ').toLowerCase().replaceAll('\\', '/');
  return command === 'metamcp'
    || command.endsWith('/metamcp')
    || args.includes('@mentu/metamcp')
    || args.includes('/metamcp/dist/index.js')
    || [config.command, ...(config.args ?? [])].some(candidate => resolvesToCurrentEntry(candidate));
}

function resolvesToCurrentEntry(candidate: string): boolean {
  const current = fileURLToPath(import.meta.url);
  const candidatePath = resolve(process.cwd(), candidate);
  if (candidatePath === current) return true;
  try {
    return realpathSync(candidatePath) === realpathSync(current);
  } catch {
    return false;
  }
}

async function main() {
  cliOptions.httpPath = normalizeHttpPath(cliOptions.httpPath);
  serverConfigs = loadConfig(cliOptions.configPath);
  const recursiveConfig = serverConfigs.find(isSelfReference);
  if (recursiveConfig) {
    throw new Error(`Refusing recursive MetaMCP child configuration: ${recursiveConfig.name}`);
  }

  // Auto-discover servers from installed editors when --import is set
  if (cliOptions.importEditors) {
    const discovered = discoverExternalServers(process.cwd());
    const localNames = new Set(serverConfigs.map(s => s.name));
    let importCount = 0;
    for (const [name, { config, source }] of discovered) {
      if (!localNames.has(name) && !isSelfReference(config)) {
        serverConfigs.push(config);
        importCount++;
        log('info', 'imported server from editor config', { name, source });
      }
    }
    if (importCount > 0) {
      log('info', 'editor import complete', { imported: importCount, total: serverConfigs.length });
    }
  }

  const cachedServerCount = childManager.loadCachedSchemas(serverConfigs);
  const methodCount = methodRegistry.reload();

  log('info', 'config loaded', {
    serverCount: serverConfigs.length,
    cachedServerCount,
    methodCount,
    methodsDir: cliOptions.methodsDir,
    allowWrites: cliOptions.allowWrites,
    maxConnections: cliOptions.maxConnections,
    idleTimeout: cliOptions.idleTimeout,
    failureThreshold: cliOptions.failureThreshold,
    cooldown: cliOptions.cooldown,
  });

  let closeInboundTransport: (() => Promise<void>) | undefined;

  if (cliOptions.transport === 'http') {
    closeInboundTransport = await startHttpTransport();
  } else {
    // Dual-era surface: legacy `initialize` clients are forwarded untouched to
    // the handlers below; MCP 2026-07-28 clients get server/discover and
    // stateless per-request handling. See src/dual-era.ts. The HTTP surface
    // above remains legacy-era for now.
    const transport = new DualEraServerTransport(new StdioServerTransport(), {
      serverInfo: { name: 'metamcp', version: readPackageVersion() },
      capabilities: { tools: {} },
      log,
    });
    await stdioServer.connect(transport);
    closeInboundTransport = () => transport.close();
    log('info', 'server started', {
      transport: 'stdio',
      eras: ['legacy', ...SUPPORTED_MODERN_PROTOCOL_VERSIONS],
    });
  }

  // Hot-reload: watch .mcp.json for changes (e.g. from `metamcp add`)
  // Uses dual strategy: watch file directly when it exists, poll as fallback.
  const configPath = resolve(cliOptions.configPath ?? '.mcp.json');
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  let lastConfigMtime = 0;

  async function reloadConfig(): Promise<void> {
    try {
      if (!existsSync(configPath)) return;
      const fresh = loadConfig(cliOptions.configPath);
      if (cliOptions.importEditors) {
        const names = new Set(fresh.map(config => config.name));
        for (const [name, { config }] of discoverExternalServers(process.cwd())) {
          if (!names.has(name) && !isSelfReference(config)) {
            fresh.push(config);
            names.add(name);
          }
        }
      }
      const recursive = fresh.find(isSelfReference);
      if (recursive) throw new Error(`Refusing recursive MetaMCP child configuration: ${recursive.name}`);
      const oldByName = new Map(serverConfigs.map(config => [config.name, config]));
      const freshByName = new Map(fresh.map(config => [config.name, config]));
      const retired: string[] = [];
      for (const [name, oldConfig] of oldByName) {
        const freshConfig = freshByName.get(name);
        if (!freshConfig || configFingerprint(oldConfig) !== configFingerprint(freshConfig)) {
          await childManager.forget(name);
          retired.push(name);
        }
      }
      serverConfigs = fresh;
      const cached = childManager.loadCachedSchemas(serverConfigs);
      log('info', 'hot-reload complete', {
        total: serverConfigs.length,
        retired: retired.length,
        cached,
      });
    } catch (err) {
      log('warn', 'hot-reload rejected; keeping the last valid config', { error: errorMessage(err) });
    }
  }

  function scheduleReload(): void {
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => { void reloadConfig(); }, 300);
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
  // Checks mtime only - no disk read unless changed.
  const pollInterval = setInterval(() => {
    try {
      if (!existsSync(configPath)) {
        if (lastConfigMtime !== 0) lastConfigMtime = 0; // file was deleted
        return;
      }
      const { mtimeMs } = statSync(configPath);
      if (mtimeMs !== lastConfigMtime) {
        if (lastConfigMtime === 0) watchFile(); // file just appeared - start watching
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
    if (closeInboundTransport) await closeInboundTransport();
    await childManager.shutdownAll();
    vectorStore?.close();
    await stdioServer.close();
    process.exit(0);
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  process.stdin.on('end', () => {
    if (!shuttingDown) {
      log('info', 'stdin closed - parent disconnected, shutting down');
      gracefulShutdown();
    }
  });

  process.on('uncaughtException', (err) => {
    log('error', 'uncaught exception', { error: err.message });
    childManager.killAllSync();
    process.exit(1);
  });
}

async function startHttpTransport(): Promise<() => Promise<void>> {
  // Resolve the auth posture once, at startup: a misconfiguration should stop
  // the server coming up, not surface as a per-request 500.
  const authConfig = resolveGatewayAuth(process.env as GatewayAuthEnv);
  const authVerifier = createGatewayVerifier(authConfig);
  const metadataPath = gatewayMetadataPath(authConfig);
  log('info', 'gateway authorization', {
    mode: authConfig.mode,
    ...(authConfig.issuer ? { issuer: authConfig.issuer } : {}),
    ...(metadataPath ? { protectedResourceMetadata: metadataPath } : {}),
    ...(authConfig.requiredScopes.length > 0 ? { requiredScopes: authConfig.requiredScopes } : {}),
  });
  if (authConfig.mode === 'open') {
    log('warn', 'gateway is unauthenticated — set METAMCP_RESOURCE_URL + METAMCP_AUTH_ISSUER for OAuth, or METAMCP_HTTP_BEARER_TOKEN for a shared secret');
  }
  if (authConfig.mode === 'open' && !isLoopbackHost(cliOptions.host)) {
    throw new Error(`Refusing unauthenticated HTTP bind on ${cliOptions.host}; bind to loopback or configure gateway authentication`);
  }
  // The resource identifier need not equal the path we serve MCP on, but a
  // mismatch is far more often a typo than an intent — and it produces tokens
  // whose audience names an endpoint that does not exist here.
  if (authConfig.resourceUrl && authConfig.resourceUrl.pathname !== cliOptions.httpPath) {
    log('warn', 'METAMCP_RESOURCE_URL path does not match the MCP path — clients will request tokens for a different audience than this endpoint serves', {
      resourcePath: authConfig.resourceUrl.pathname,
      httpPath: cliOptions.httpPath,
    });
  }

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        sendJson(res, 200, {
          ok: true,
          name: 'metamcp',
          version: readPackageVersion(),
          transport: 'http',
        });
        return;
      }

      // RFC 9728: served unauthenticated by design — it is the document a
      // client reads precisely because it does not yet have a token.
      if (metadataPath && url.pathname === metadataPath) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, HEAD');
          res.end('Method Not Allowed');
          return;
        }
        sendJson(res, 200, gatewayMetadataDocument(authConfig));
        return;
      }

      if (url.pathname !== cliOptions.httpPath) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      const rawOrigin = req.headers.origin;
      const origin = typeof rawOrigin === 'string' ? rawOrigin : undefined;
      if (Array.isArray(rawOrigin) || (origin && !cliOptions.allowedOrigins.includes(origin))) {
        res.setHeader('Vary', 'Origin');
        sendJson(res, 403, { error: 'origin_not_allowed' });
        return;
      }
      if (origin) {
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type, Accept, X-MetaMCP-Token, Mcp-Protocol-Version, Mcp-Method, Mcp-Name',
        );
        res.setHeader('Access-Control-Max-Age', '600');
        res.end();
        return;
      }

      const decision = await authorizeGatewayRequest(
        authConfig,
        req.headers as { authorization?: string; 'x-metamcp-token'?: string },
        authVerifier,
      );
      if (!decision.ok) {
        // The challenge carries the metadata URL and any required scopes, so a
        // client can discover where to authenticate instead of guessing.
        if (decision.challenge) res.setHeader('WWW-Authenticate', decision.challenge);
        sendJson(res, decision.status ?? 401, {
          error: decision.error ?? 'unauthorized',
          ...(decision.errorDescription ? { error_description: decision.errorDescription } : {}),
        });
        return;
      }

      if (req.method === 'POST') {
        await handleStatelessMcpPost(req, res);
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        sendJson(res, 405, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed.' },
          id: null,
        });
        return;
      }

      res.statusCode = 405;
      res.setHeader('Allow', 'GET, POST, DELETE');
      res.end('Method Not Allowed');
    } catch (err) {
      log('error', 'http transport request failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(cliOptions.port, cliOptions.host, () => {
      httpServer.off('error', rejectListen);
      log('info', 'server started', {
        transport: 'http',
        host: cliOptions.host,
        port: cliOptions.port,
        path: cliOptions.httpPath,
      });
      resolveListen();
    });
  });

  return async () => {
    await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
  };
}

async function handleStatelessMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestServer = createMetaMcpServer();
  const innerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const transport = new DualEraServerTransport(innerTransport, {
    serverInfo: { name: 'metamcp', version: readPackageVersion() },
    capabilities: { tools: {} },
    log,
  });

  let closed = false;
  const closeRequestServer = async () => {
    if (closed) return;
    closed = true;
    await transport.close();
    await requestServer.close();
  };

  res.on('close', () => {
    void closeRequestServer();
  });

  await requestServer.connect(transport);
  const body = await readJsonBody(req);
  const headerError = validateModernHttpHeaders(req, body);
  if (headerError) {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: isRecord(body) && ('id' in body) ? body.id : null,
      error: { code: -32020, message: headerError },
    });
    await closeRequestServer();
    return;
  }
  await innerTransport.handleRequest(req, res, body);
  if (res.writableEnded) await closeRequestServer();
}


function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 4 * 1024 * 1024) {
        rejectBody(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', rejectBody);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) {
        resolveBody(undefined);
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(new Error('invalid JSON request body'));
      }
    });
  });
}

function validateModernHttpHeaders(req: IncomingMessage, body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.method !== 'string') return undefined;
  const methodHeader = singleHeader(req.headers['mcp-method']);
  if (methodHeader && methodHeader !== body.method) {
    return `Mcp-Method header ${methodHeader} does not match body method ${body.method}`;
  }

  const params = isRecord(body.params) ? body.params : undefined;
  const name = params && typeof params.name === 'string' ? params.name : undefined;
  const nameHeader = singleHeader(req.headers['mcp-name']);
  if (nameHeader && nameHeader !== name) {
    return `Mcp-Name header ${nameHeader} does not match body name ${String(name)}`;
  }

  const meta = params && isRecord(params._meta) ? params._meta : undefined;
  const bodyVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
  const versionHeader = singleHeader(req.headers['mcp-protocol-version']);
  if (versionHeader && bodyVersion !== undefined && versionHeader !== bodyVersion) {
    return `Mcp-Protocol-Version header ${versionHeader} does not match body protocol version ${String(bodyVersion)}`;
  }
  return undefined;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

main().catch(err => {
  log('error', 'fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
