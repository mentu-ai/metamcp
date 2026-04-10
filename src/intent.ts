import type { ToolMatch, RegistryEntry } from './types.js';
import type { ToolCatalog } from './catalog.js';
import type { PerceptionMode, PerceptionResult, RankedTool } from './perception.js';
import type { JudgmentPolicy, ServerMeta, ServerScore, EvidenceState } from './judgment.js';
import { MCPRegistry } from './registry.js';

const LOCAL_CONFIDENCE_THRESHOLD = 0.5;

export interface JudgmentContext {
  judgment: JudgmentPolicy;
  serverMeta: Map<string, ServerMeta>;
  evidenceState: EvidenceState;
}

export interface IntentResult {
  localMatches: ToolMatch[];
  registryMatches: RegistryEntry[];
  ranked?: RankedTool[];
  serverScores?: ServerScore[];
  source: 'local' | 'registry' | 'both';
}

export class IntentRouter {
  private registry: MCPRegistry;
  private perception: PerceptionMode | null;

  constructor(registry?: MCPRegistry, perception?: PerceptionMode) {
    this.registry = registry ?? new MCPRegistry();
    this.perception = perception ?? null;
  }

  /**
   * Resolution order (NON-NEGOTIABLE):
   * 1. Local catalog first (search pre-configured + already-provisioned servers)
   * 2. If perception available, filter and rank by domain + relevance
   * 3. If judgment available, re-order by server priority (budget-aware)
   * 4. Registry fallback (if local produces no matches above 0.5 confidence)
   * 5. Return ranked matches with confidence scores
   */
  async resolve(
    intent: string,
    catalog: ToolCatalog,
    context?: string,
    judgmentCtx?: JudgmentContext,
  ): Promise<IntentResult> {
    const query = context ? `${intent} ${context}` : intent;

    // 1. Local catalog first
    const localMatches = await catalog.search(query);
    const highConfidence = localMatches.filter(m => m.confidence >= LOCAL_CONFIDENCE_THRESHOLD);

    if (highConfidence.length > 0) {
      // 2. Perception filter (if available) — re-rank by domain + relevance
      const ranked = this.perception
        ? await this.perception.enrichSearchResults(highConfidence, query)
        : undefined;

      // 3. Judgment: server prioritization — re-order matches by server score
      let serverScores: ServerScore[] | undefined;
      if (judgmentCtx) {
        const servers = [...new Set(highConfidence.map(m => m.tool.server))];
        const perceptionScores = buildPerceptionScoreMap(ranked, servers);
        serverScores = judgmentCtx.judgment.prioritizeServers(
          servers, perceptionScores, judgmentCtx.serverMeta, judgmentCtx.evidenceState,
        );
        const serverOrder = new Map(serverScores.map((s, i) => [s.server, i]));
        highConfidence.sort((a, b) => {
          const aOrder = serverOrder.get(a.tool.server) ?? Infinity;
          const bOrder = serverOrder.get(b.tool.server) ?? Infinity;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return b.confidence - a.confidence;
        });
      }

      return {
        localMatches: highConfidence,
        registryMatches: [],
        ranked,
        serverScores,
        source: 'local',
      };
    }

    // 3. Registry fallback
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

/**
 * Build a per-server perception score map from ranked tool results.
 * Takes the best domain score per server. Falls back to neutral 0.5 for
 * servers without perception data.
 */
function buildPerceptionScoreMap(
  ranked: RankedTool[] | undefined,
  servers: string[],
): Map<string, PerceptionResult> {
  const map = new Map<string, PerceptionResult>();
  if (ranked) {
    for (const r of ranked) {
      const existing = map.get(r.tool.server);
      if (!existing || r.domain.score > existing.score) {
        map.set(r.tool.server, r.domain);
      }
    }
  }
  // Ensure all servers have an entry (neutral fallback)
  for (const server of servers) {
    if (!map.has(server)) {
      map.set(server, {
        label: 'unknown',
        score: 0.5,
        adapter: 'fallback',
        latency_ms: 0,
        fallback_used: true,
      });
    }
  }
  return map;
}
