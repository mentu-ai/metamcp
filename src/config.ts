import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidServerName, type ServerConfig, type ServerLifecycle } from './types.js';
import { log } from './log.js';
import { resolveSecrets } from './vault-resolver.js';
import { registerSecretValues } from './secret-scrubber.js';

export function loadConfig(configPath?: string): ServerConfig[] {
  const path = configPath ?? resolve(process.cwd(), '.mcp.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (configPath) {
      throw new Error(`Unable to read MetaMCP config ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const example = resolve(process.cwd(), '.mcp.example.json');
    if (existsSync(example)) {
      log('warn', '.mcp.json not found - copy .mcp.example.json to .mcp.json and edit it');
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in MetaMCP config ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid MetaMCP config ${path}: top-level value must be an object`);
  }

  const servers = parsed.mcpServers;
  if (!servers) return [];
  if (typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`Invalid MetaMCP config ${path}: mcpServers must be an object`);
  }

  const result: ServerConfig[] = [];

  for (const [name, entry] of Object.entries(servers)) {
    if (!isValidServerName(name)) {
      throw new Error(`Invalid server name ${JSON.stringify(name)}: use 1-128 letters, numbers, dots, underscores, or hyphens`);
    }
    if (!isRecord(entry)) {
      throw new Error(`Invalid server ${name}: configuration must be an object`);
    }
    if (entry.command !== undefined && (typeof entry.command !== 'string' || !entry.command.trim())) {
      throw new Error(`Invalid server ${name}: command must be a non-empty string`);
    }
    if (entry.url !== undefined && (typeof entry.url !== 'string' || !entry.url.trim())) {
      throw new Error(`Invalid server ${name}: url must be a non-empty string`);
    }
    if (entry.transportType !== undefined && typeof entry.transportType !== 'string') {
      throw new Error(`Invalid server ${name}: transportType must be a string`);
    }
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string'))) {
      throw new Error(`Invalid server ${name}: args must be an array of strings`);
    }
    if (entry.env !== undefined && !isEnvironmentRecord(entry.env)) {
      throw new Error(`Invalid server ${name}: env must contain string values`);
    }
    if (entry.headers !== undefined && !isHeaderRecord(entry.headers)) {
      throw new Error(`Invalid server ${name}: headers must contain string values`);
    }
    if (entry.oauth !== undefined && typeof entry.oauth !== 'boolean') {
      throw new Error(`Invalid server ${name}: oauth must be a boolean`);
    }
    if (entry.oauthClientMetadataUrl !== undefined) {
      if (typeof entry.oauthClientMetadataUrl !== 'string') {
        throw new Error(`Invalid server ${name}: oauthClientMetadataUrl must be a string`);
      }
      let metadataUrl: URL;
      try {
        metadataUrl = new URL(entry.oauthClientMetadataUrl);
      } catch {
        throw new Error(`Invalid server ${name}: oauthClientMetadataUrl is invalid`);
      }
      if (metadataUrl.protocol !== 'https:') {
        throw new Error(`Invalid server ${name}: oauthClientMetadataUrl must use https`);
      }
    }
    if (entry.oauthScope !== undefined && (typeof entry.oauthScope !== 'string' || !entry.oauthScope.trim())) {
      throw new Error(`Invalid server ${name}: oauthScope must be a non-empty string`);
    }
    if (!entry.command && !entry.url) {
      throw new Error(`Invalid server ${name}: command or url is required`);
    }
    if (entry.command && entry.url) {
      throw new Error(`Invalid server ${name}: command and url are mutually exclusive`);
    }
    if (entry.transportType !== undefined && !entry.url) {
      throw new Error(`Invalid server ${name}: transportType requires url`);
    }
    if ((entry.oauth || entry.oauthClientMetadataUrl || entry.oauthScope) && !entry.url) {
      throw new Error(`Invalid server ${name}: OAuth fields require url`);
    }

    const config: ServerConfig = {
      name,
      command: entry.command ?? '',
      criticality: 'vital',
    };

    if (entry.args) config.args = entry.args;
    // Expand ${KEY} references through the configured secret-provider chain.
    if (entry.env) {
      config.env = resolveSecrets(entry.env, secret => registerSecretValues([secret]));
      registerSecretValues(secretValues(config.env, entry.env));
    }
    if (entry.inheritEnv) {
      if (!Array.isArray(entry.inheritEnv) || entry.inheritEnv.some(name => typeof name !== 'string' || !ENVIRONMENT_NAME_PATTERN.test(name))) {
        throw new Error(`Invalid inheritEnv for server ${name}: expected non-empty environment variable names`);
      }
      config.inheritEnv = Array.from(new Set(entry.inheritEnv));
    }
    if (entry.url) {
      let remoteUrl: URL;
      try {
        remoteUrl = new URL(entry.url);
      } catch {
        throw new Error(`Invalid server ${name}: url is invalid`);
      }
      if (remoteUrl.protocol !== 'http:' && remoteUrl.protocol !== 'https:') {
        throw new Error(`Invalid server ${name}: url must use http or https`);
      }
      config.url = entry.url;
      const t = entry.transportType?.toLowerCase();
      if (t !== undefined && t !== 'http' && t !== 'sse') {
        throw new Error(`Invalid server ${name}: transportType must be http or sse`);
      }
      config.transport = t === 'sse' ? 'sse' : 'http';
      if (config.transport === 'sse' && entry.oauth) {
        throw new Error(`Invalid server ${name}: OAuth is supported only for Streamable HTTP`);
      }
    }
    if (entry.headers) {
      config.headers = resolveSecrets(entry.headers, secret => registerSecretValues([secret]));
      registerSecretValues(secretValues(config.headers, entry.headers));
    }
    if (entry.oauth) config.oauth = entry.oauth;
    if (entry.oauthClientMetadataUrl) config.oauthClientMetadataUrl = entry.oauthClientMetadataUrl;
    if (entry.oauthScope) config.oauthScope = entry.oauthScope;
    if (entry.timeoutMs !== undefined) {
      const timeoutMs = entry.timeoutMs;
      if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
        throw new Error(`Invalid server ${name}: timeoutMs must be an integer from 1 to 600000`);
      }
      config.timeoutMs = timeoutMs;
    }
    if (entry.lifecycle) {
      const rawLifecycle = entry.lifecycle;
      if (typeof rawLifecycle !== 'string'
        && (!isRecord(rawLifecycle) || typeof rawLifecycle.mode !== 'string')) {
        throw new Error(`Invalid server ${name}: lifecycle must be keep-alive or ephemeral`);
      }
      if (typeof rawLifecycle !== 'string' && rawLifecycle.idleTimeoutMs !== undefined
        && (!Number.isSafeInteger(rawLifecycle.idleTimeoutMs) || Number(rawLifecycle.idleTimeoutMs) < 1)) {
        throw new Error(`Invalid server ${name}: lifecycle.idleTimeoutMs must be a positive integer`);
      }
      const lifecycle = parseLifecycle(rawLifecycle as string | { mode: string; idleTimeoutMs?: number });
      if (!lifecycle) throw new Error(`Invalid server ${name}: lifecycle must be keep-alive or ephemeral`);
      config.lifecycle = lifecycle;
    }

    result.push(config);
  }

  return result;
}

function secretValues(record: Record<string, string>, source: Record<string, string>): string[] {
  return Object.entries(record)
    .filter(([name]) => /(?:authorization|credential|password|secret|token|api[_-]?key|private[_-]?key)/i.test(name)
      || source[name]?.includes('${'))
    .map(([, value]) => value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isEnvironmentRecord(value: unknown): value is Record<string, string> {
  return isRecord(value)
    && Object.entries(value).every(([name, item]) => ENVIRONMENT_NAME_PATTERN.test(name) && typeof item === 'string' && !item.includes('\0'));
}

function isHeaderRecord(value: unknown): value is Record<string, string> {
  return isRecord(value)
    && Object.entries(value).every(([name, item]) => HEADER_NAME_PATTERN.test(name) && typeof item === 'string' && !/[\r\n]/.test(item));
}

function parseLifecycle(raw: string | { mode: string; idleTimeoutMs?: number }): ServerLifecycle | undefined {
  if (typeof raw === 'string') {
    if (raw === 'keep-alive') return { mode: 'keep-alive' };
    if (raw === 'ephemeral') return { mode: 'ephemeral' };
    return undefined;
  }
  if (raw.mode === 'keep-alive') {
    const timeout = typeof raw.idleTimeoutMs === 'number' && raw.idleTimeoutMs > 0
      ? Math.trunc(raw.idleTimeoutMs)
      : undefined;
    return timeout ? { mode: 'keep-alive', idleTimeoutMs: timeout } : { mode: 'keep-alive' };
  }
  if (raw.mode === 'ephemeral') return { mode: 'ephemeral' };
  return undefined;
}
