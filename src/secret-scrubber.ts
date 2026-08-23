/**
 * Output scrubber - redacts secrets from text before it leaves the process.
 *
 * Catches JWT tokens, API keys (OpenAI, GitHub, Slack, AWS), and
 * sensitive key-value pairs in JSON-shaped strings.
 */

const INLINE_SECRET_PATTERNS: [RegExp, string][] = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JWT'],
  [/sk-[A-Za-z0-9-]{20,}/g, 'KEY'],
  [/ghp_[A-Za-z0-9]{20,}/g, 'KEY'],
  [/xoxb-[A-Za-z0-9-]+/g, 'KEY'],
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/g, 'KEY'],
];

const SENSITIVE_JSON_KEYS =
  /("(?:password|secret|token|api_key|apiKey|access_token|refresh_token|authorization|private_key|credential)")\s*:\s*"([^"]+)"/gi;

const configuredSecretValues = new Set<string>();

/** Register resolved per-child credentials for exact-value response redaction. */
export function registerSecretValues(values: Iterable<string>): void {
  for (const value of values) {
    if (value.length < 4) continue;
    configuredSecretValues.add(value);
    const bearer = value.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer && bearer.length >= 4) configuredSecretValues.add(bearer);
  }
}

/** Replace known secret patterns with `[REDACTED:LABEL]`. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const secret of Array.from(configuredSecretValues).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[REDACTED:CONFIG]');
  }
  for (const [pattern, label] of INLINE_SECRET_PATTERNS) {
    // Reset lastIndex - regexes are /g so state carries over
    pattern.lastIndex = 0;
    out = out.replace(pattern, `[REDACTED:${label}]`);
  }
  out = out.replace(SENSITIVE_JSON_KEYS, (_m, key: string) => `${key}: "[REDACTED:VALUE]"`);
  return out;
}

/** Recursively scrub strings in structured MCP results without changing shape. */
export function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, scrubValue(child)]),
    );
  }
  return value;
}
