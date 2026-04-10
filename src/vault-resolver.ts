import { execFileSync } from 'node:child_process';
import { log } from './log.js';

const vaultCache = new Map<string, string | null>();

function vaultGet(key: string): string | null {
  if (vaultCache.has(key)) return vaultCache.get(key)!;
  try {
    const value = execFileSync('mentu', ['vault', 'get', key, '--raw'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    vaultCache.set(key, value);
    return value;
  } catch {
    vaultCache.set(key, null);
    return null;
  }
}

export function resolveSecrets(record: Record<string, string> | undefined): Record<string, string> {
  if (!record) return {};
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    const match = value.match(/^\$\{(.+)\}$/);
    if (match) {
      const refKey = match[1];
      const vaultValue = vaultGet(refKey);
      if (vaultValue) {
        resolved[name] = vaultValue;
      } else if (process.env[refKey]) {
        resolved[name] = process.env[refKey]!;
      } else {
        log('warn', `unresolved secret: \${${refKey}}`, { field: name });
        resolved[name] = value;
      }
    } else {
      resolved[name] = value;
    }
  }
  return resolved;
}

export function clearVaultCache(): void {
  vaultCache.clear();
}
