import type { ToolMatch, RegistryEntry } from './types.js';
import type { ToolCatalog } from './catalog.js';
import { MCPRegistry } from './registry.js';

const LOCAL_CONFIDENCE_THRESHOLD = 0.5;

export interface IntentResult {
  localMatches: ToolMatch[];
  registryMatches: RegistryEntry[];
  source: 'local' | 'registry' | 'both';
}

export class IntentRouter {
  private registry: MCPRegistry;

  constructor(registry?: MCPRegistry) {
    this.registry = registry ?? new MCPRegistry();
  }

  /**
   * Resolution order (NON-NEGOTIABLE):
   * 1. Local catalog first (search pre-configured + already-provisioned servers)
   * 2. Registry fallback (if local produces no matches above 0.5 confidence)
   * 3. Return ranked matches with confidence scores
   */
  async resolve(intent: string, catalog: ToolCatalog, context?: string): Promise<IntentResult> {
    const query = context ? `${intent} ${context}` : intent;

    // 1. Local catalog first
    const localMatches = await catalog.search(query);
    const highConfidence = localMatches.filter(m => m.confidence >= LOCAL_CONFIDENCE_THRESHOLD);

    if (highConfidence.length > 0) {
      return {
        localMatches: highConfidence,
        registryMatches: [],
        source: 'local',
      };
    }

    // 2. Registry fallback
    await this.registry.getEntries();
    const registryMatches = this.registry.search(intent);

    if (localMatches.length > 0) {
      return {
        localMatches,
        registryMatches,
        source: 'both',
      };
    }

    return {
      localMatches: [],
      registryMatches,
      source: 'registry',
    };
  }

  getRegistry(): MCPRegistry {
    return this.registry;
  }
}
