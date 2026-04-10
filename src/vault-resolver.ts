import { execSync } from 'node:child_process';
import { log } from './log.js';

/**
 * Vault-aware secret resolution for MetaMCP config values.
 *
 * Resolution order for ${KEY} references:
 *   1. mentu vault (macOS Keychain or age-encrypted file)
 *   2. process.env
 *   3. warning + leave literal
 *
 * All vault lookups are cached for the process lifetime.
 * Resolution happens once at config load time — no per-connection overhead.
 */

const vaultCache = new Map<string, string | null>();

function vaultGet(key: string): string | null {
  if (vaultCache.has(key)) return vaultCache.get(key)!;

  const mentuVault = `"${process.env.HOME}/.local/bin/mentu-vault"`;
  const workspace = process.env.MENTU_WORKSPACE;

  // Try scoped first (if workspace is known)
  if (workspace) {
    try {
      const value = execSync(
        `${mentuVault} get --scope ${workspace} ${key} --raw`,
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      vaultCache.set(key, value);
      return value;
    } catch { /* fall through to global */ }
  }

  // Try global
  try {
    const value = execSync(
      `${mentuVault} get ${key} --raw`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    vaultCache.set(key, value);
    return value;
  } catch {
    vaultCache.set(key, null);
    return null;
  }
}

/**
 * Resolve ${KEY} references in a string record (env vars or headers).
 * Values without ${} syntax are passed through unchanged.
 */
export function resolveSecrets(
  record: Record<string, string> | undefined
): Record<string, string> {
  if (!record) return {};

  const resolved: Record<string, string> = {};

  for (const [name, value] of Object.entries(record)) {
    // Replace all ${KEY} references inline (handles "Bearer ${TOKEN}" and standalone "${TOKEN}")
    if (value.includes('${')) {
      resolved[name] = value.replace(/\$\{(\w+)\}/g, (fullMatch, refKey) => {
        const vaultValue = vaultGet(refKey);
        if (vaultValue) return vaultValue;
        if (process.env[refKey]) return process.env[refKey]!;
        log('warn', `unresolved secret: \${${refKey}}`, { field: name });
        return fullMatch; // leave literal
      });
    } else {
      resolved[name] = value;
    }
  }

  return resolved;
}

/** Clear the vault cache (for testing or config reload). */
export function clearVaultCache(): void {
  vaultCache.clear();
}
