import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TrustDecision } from './types.js';
import { log } from './log.js';

const TRUST_DIR = join(homedir(), '.metamcp');
const TRUST_FILE = join(TRUST_DIR, 'trusted-servers.json');
const CONFIDENCE_THRESHOLD = 0.9;

export class TrustPolicy {
  private allowlist: string[] = [];

  constructor() {
    this.loadAllowlist();
  }

  /**
   * NON-NEGOTIABLE trust enforcement — two independent gates, BOTH must pass:
   *
   * 1. Namespace Trust: Is the package namespace in trusted-servers.json?
   * 2. Semantic Confidence: Does the match score >= 0.9?
   *
   * High semantic confidence alone is NOT sufficient. A malicious package
   * can score 0.99 on intent matching.
   */
  evaluate(packageName: string, confidence: number): TrustDecision {
    const namespace = this.extractNamespace(packageName);
    const trusted = this.isNamespaceTrusted(namespace);
    const meetsConfidence = confidence >= CONFIDENCE_THRESHOLD;

    const decision: TrustDecision = {
      namespace,
      trusted,
      confidence,
      decision: trusted && meetsConfidence ? 'allow' : 'deny',
    };

    log('info', 'provision decision', {
      namespace: decision.namespace,
      trusted: decision.trusted,
      confidence: decision.confidence,
      decision: decision.decision,
    });

    return decision;
  }

  canAutoProvision(packageName: string, confidence: number): boolean {
    const decision = this.evaluate(packageName, confidence);
    return decision.decision === 'allow';
  }

  private isNamespaceTrusted(namespace: string): boolean {
    for (const pattern of this.allowlist) {
      if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -2);
        if (namespace === prefix || namespace.startsWith(prefix + '/')) {
          return true;
        }
      } else if (pattern === namespace) {
        return true;
      }
    }
    return false;
  }

  private extractNamespace(name: string): string {
    if (name.startsWith('@')) {
      const slashIndex = name.indexOf('/');
      if (slashIndex > 0) {
        return name.substring(0, slashIndex);
      }
    }
    return name;
  }

  private loadAllowlist(): void {
    try {
      const raw = readFileSync(TRUST_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.allowlist = parsed.filter((e): e is string => typeof e === 'string');
      }
    } catch {
      // No trust file — empty allowlist (deny all auto-provision)
      this.allowlist = [];
    }
  }

  initializeDefault(): void {
    const defaults = [
      '@modelcontextprotocol/*',
      '@anthropic/*',
    ];
    try {
      mkdirSync(TRUST_DIR, { recursive: true });
      writeFileSync(TRUST_FILE, JSON.stringify(defaults, null, 2));
      this.allowlist = defaults;
    } catch {
      // ignore
    }
  }
}
