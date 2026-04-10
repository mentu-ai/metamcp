import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { ServerConfig, IntentRouteMap } from './types.js';
import type { ElicitationConfig, ElicitationMode } from './elicitation.js';
import { log } from './log.js';
import { resolveSecrets } from './vault-resolver.js';
import { loadActivation, isActivated, getTier } from './activation.js';

interface McpJsonEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  sandbox?: string;  // Path to .sandbox.json profile for VM isolation
  criticality?: 'vital' | 'optional';
  type?: 'stdio' | 'http' | 'sse' | 'unix-http' | 'unix-jsonrpc';  // Transport type (default: stdio)
  url?: string;                      // Remote server URL (for http/sse)
  socketPath?: string;               // Unix domain socket path (for unix-http/unix-jsonrpc)
  headers?: Record<string, string>;  // Auth headers (env var interpolation)
  auth?: 'none' | 'bearer' | 'oauth';  // Auth method (default: none)
  vmIsolation?: boolean;              // Run inside mentu-runtime VM
  timeout?: number;                   // Per-tool-call timeout in ms (default: 60000)
  engine?: 'hybrid' | 'native' | 'bridge';  // Execution engine mode
}


interface McpJsonFile {
  mcpServers?: Record<string, McpJsonEntry>;
  intents?: Record<string, string>;
  elicitation?: {
    mode?: string;
    autoResponses?: Record<string, Record<string, unknown>>;
  };
  dependencies?: Record<string, {
    requires_server?: string[];
    requires_service?: Array<{ check: string; name: string }>;
    requires_env?: string[];
  }>;
}

export interface ServerDependency {
  requires_server?: string[];
  requires_service?: Array<{ check: string; name: string }>;
  requires_env?: string[];
}

export interface MetaMcpConfig {
  servers: ServerConfig[];
  intents: IntentRouteMap;
  elicitation: ElicitationConfig;
  dependencies: Record<string, ServerDependency>;
}

const VALID_ELICITATION_MODES: ElicitationMode[] = ['auto', 'interactive', 'deny'];

export function loadConfig(configPath?: string): ServerConfig[];
export function loadConfig(configPath: string | undefined, full: true): MetaMcpConfig;
export function loadConfig(configPath?: string, full?: true): ServerConfig[] | MetaMcpConfig {
  // Config resolution: ~/.mentu/mcp.json > .mcp.json > .metamcp.json (deprecated)
  const configPaths = [
    join(homedir(), '.mentu', 'mcp.json'),     // Canonical path
    resolve(process.cwd(), '.mcp.json'),        // Standard MCP config
    resolve(process.cwd(), '.metamcp.json'),    // Legacy — deprecation warning
  ];
  const defaultPath = configPaths.find(p => existsSync(p)) ?? resolve(process.cwd(), '.mcp.json');
  const path = configPath ?? defaultPath;

  if (path.endsWith('.metamcp.json')) {
    log('warn', 'Using deprecated .metamcp.json — migrate to ~/.mentu/mcp.json or .mcp.json');
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    const example = resolve(process.cwd(), '.mcp.example.json');
    if (existsSync(example)) {
      log('warn', '.mcp.json not found — copy .mcp.example.json to .mcp.json and edit it');
    }
    if (full) return { servers: [], intents: {}, elicitation: { mode: 'auto' }, dependencies: {} };
    return [];
  }

  let parsed: McpJsonFile;
  try {
    parsed = JSON.parse(raw) as McpJsonFile;
  } catch {
    log('error', 'config parse failed', { path });
    if (full) return { servers: [], intents: {}, elicitation: { mode: 'auto' }, dependencies: {} };
    return [];
  }

  const servers = parsed.mcpServers;
  const serverConfigs: ServerConfig[] = servers
    ? Object.entries(servers).map(([name, entry]) => ({
        name,
        command: entry.command ?? '',
        args: entry.args,
        env: resolveSecrets(entry.env),
        sandbox: entry.sandbox,
        criticality: entry.criticality === 'vital' ? 'vital' as const : 'optional' as const,
        transport: (entry.type ?? 'stdio') as ServerConfig['transport'],
        url: entry.url,
        headers: entry.headers ? resolveSecrets(entry.headers) : undefined,
        auth: (entry.auth as ServerConfig['auth']) ?? undefined,
        vmIsolation: entry.vmIsolation,
        socketPath: entry.socketPath,
        timeoutMs: entry.timeout,
        engine: entry.engine ?? 'hybrid',
      }))
    : [];

  // Activation gate: filter by activated.json and set vmIsolation from tier
  const activation = loadActivation();
  const activatedNames = new Set(Object.keys(activation.activated));
  const filteredConfigs = serverConfigs.filter(c => {
    // Backward compat: servers not in activated.json pass through
    if (!activatedNames.has(c.name)) return true;
    return isActivated(c.name);
  });
  for (const c of filteredConfigs) {
    if (getTier(c.name) === 'vm') {
      c.vmIsolation = true;
    }
  }
  if (filteredConfigs.length < serverConfigs.length) {
    log('info', 'activation gate filtered servers', {
      before: serverConfigs.length,
      after: filteredConfigs.length,
    });
  }

  if (!full) return filteredConfigs;

  // Parse intent routing config
  const intents: IntentRouteMap = {};
  if (parsed.intents) {
    for (const [phase, target] of Object.entries(parsed.intents)) {
      if (typeof target === 'string' && target.includes('.')) {
        intents[phase] = target;
      } else {
        log('warn', 'invalid intent route — must be "server.tool"', { phase, target });
      }
    }
    if (Object.keys(intents).length > 0) {
      log('info', 'intent routes loaded', { count: Object.keys(intents).length });
    }
  }

  // Parse elicitation config
  const elicitation: ElicitationConfig = { mode: 'auto' };
  if (parsed.elicitation) {
    const mode = parsed.elicitation.mode as ElicitationMode | undefined;
    if (mode && VALID_ELICITATION_MODES.includes(mode)) {
      elicitation.mode = mode;
    }
    if (parsed.elicitation.autoResponses) {
      elicitation.autoResponses = parsed.elicitation.autoResponses;
    }
  }

  // Parse dependencies config
  const dependencies: Record<string, ServerDependency> = {};
  if (parsed.dependencies) {
    for (const [server, dep] of Object.entries(parsed.dependencies)) {
      dependencies[server] = {
        requires_server: dep.requires_server,
        requires_service: dep.requires_service,
        requires_env: dep.requires_env,
      };
    }
    if (Object.keys(dependencies).length > 0) {
      log('info', 'dependency graph loaded', { count: Object.keys(dependencies).length });
    }
  }

  return { servers: filteredConfigs, intents, elicitation, dependencies };
}
