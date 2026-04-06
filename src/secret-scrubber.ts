/**
 * Output scrubber — redacts secrets from text before it leaves the process.
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

/** Replace known secret patterns with `[REDACTED:LABEL]`. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [pattern, label] of INLINE_SECRET_PATTERNS) {
    // Reset lastIndex — regexes are /g so state carries over
    pattern.lastIndex = 0;
    out = out.replace(pattern, `[REDACTED:${label}]`);
  }
  out = out.replace(SENSITIVE_JSON_KEYS, (_m, key: string) => `${key}: "[REDACTED:VALUE]"`);
  return out;
}
