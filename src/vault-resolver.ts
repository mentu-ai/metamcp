/** A secret source supplied by the host application. */
export interface SecretProvider {
  readonly name: string;
  resolve(key: string): string | undefined;
}

const environmentProvider: SecretProvider = {
  name: 'environment',
  resolve: key => process.env[key],
};

let secretProviders: readonly SecretProvider[] = [environmentProvider];

/** Replace the provider chain. Embedders can add a keychain or vault adapter. */
export function setSecretProviders(providers: readonly SecretProvider[]): void {
  secretProviders = providers.length > 0 ? [...providers] : [environmentProvider];
}

/**
 * Resolve ${KEY} references in a string record (env vars or headers).
 * Values without ${} syntax are passed through unchanged.
 */
export function resolveSecrets(
  record: Record<string, string> | undefined,
  onResolvedSecret?: (value: string) => void,
): Record<string, string> {
  if (!record) return {};

  const resolved: Record<string, string> = {};

  for (const [name, value] of Object.entries(record)) {
    // Replace all ${KEY} references inline (handles "Bearer ${TOKEN}" and standalone "${TOKEN}")
    if (value.includes('${')) {
      const expanded = value.replace(/\$\{([^}]*)\}/g, (_fullMatch, refKey: string) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(refKey)) {
          throw new Error(`Invalid secret reference in field ${name}`);
        }
        for (const provider of secretProviders) {
          const secret = provider.resolve(refKey);
          if (secret !== undefined) {
            onResolvedSecret?.(secret);
            return secret;
          }
        }
        throw new Error(`Unresolved secret reference \${${refKey}} in field ${name}`);
      });
      if (expanded.includes('${')) {
        throw new Error(`Invalid secret reference in field ${name}`);
      }
      resolved[name] = expanded;
    } else {
      resolved[name] = value;
    }
  }

  return resolved;
}

/** Restore the default environment provider (primarily for tests). */
export function clearVaultCache(): void {
  secretProviders = [environmentProvider];
}
