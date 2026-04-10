import type { ToolDefinition, ToolMatch } from './types.js';
import { Store } from './store.js';
import type { VectorStore, VectorSearchResult } from './vector-store.js';
import type { Embedder } from './embedder.js';
import type { PerceptionProvider, PerceptionResult, ToolArtifact, RankedTool } from './perception.js';
import { toArtifact, DOMAIN_KEYWORDS, PerceptionMode } from './perception.js';

/**
 * Two-tier tool catalog with Store-backed caching and hybrid search.
 *
 * Hybrid search: semantic similarity + keyword scoring.
 *
 * PiecesOS uses pure vector similarity (search_simd.rs).
 * MetaMCP adds keyword scoring as a second signal because:
 * - Tool names are highly structured (not natural language)
 * - Exact name matches should always rank highest
 * - Keyword scoring is the proven fallback when embeddings unavailable
 *
 * Score formula (2-tier): 0.6 * semantic + 0.4 * keyword (normalized)
 * Score formula (3-tier, when perception batch ready): 0.45 * semantic + 0.30 * keyword + 0.25 * perception
 */
const SCORE_EXACT_NAME = 10;
const SCORE_NAME_CONTAINS = 5;
const SCORE_DESC_CONTAINS = 2;
const DEFAULT_TOP_N = 20;
const CATALOG_TTL_MS = 3_600_000;     // 1 hour
const CATALOG_CLEANUP_MS = 300_000;   // 5 minutes

const SEMANTIC_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;
const VECTOR_CANDIDATE_LIMIT = 50;

// 3-tier weights (used when perception batch cache is ready)
const SEMANTIC_WEIGHT_3T = 0.45;
const KEYWORD_WEIGHT_3T = 0.30;
const PERCEPTION_WEIGHT = 0.25;

export interface CatalogOptions {
  loader?: (serverName: string) => Promise<ToolDefinition[]>;
  vectorStore?: VectorStore;
  embedder?: Embedder;
  perceptionProvider?: PerceptionProvider;
}

function normalize(scores: number[]): number[] {
  const max = Math.max(...scores);
  if (max === 0) return scores.map(() => 0);
  return scores.map(s => s / max);
}

export class ToolCatalog {
  private store: Store<string, ToolDefinition[]>;
  private vectorStore: VectorStore | null;
  private embedder: Embedder | null;
  private perceptionProvider: PerceptionProvider | null;

  constructor(options?: CatalogOptions) {
    this.store = new Store<string, ToolDefinition[]>({
      loader: options?.loader ?? (async () => []),
      defaultTtlMs: CATALOG_TTL_MS,
    });
    this.store.startCleanup(CATALOG_CLEANUP_MS);
    this.vectorStore = options?.vectorStore ?? null;
    this.embedder = options?.embedder ?? null;
    this.perceptionProvider = options?.perceptionProvider ?? null;
  }

  registerServer(serverName: string, tools: ToolDefinition[]): void {
    this.store.set(serverName, tools);
  }

  async registerServerWithEmbeddings(serverName: string, tools: ToolDefinition[]): Promise<void> {
    this.store.set(serverName, tools);

    if (!this.vectorStore || !this.embedder || !this.embedder.isAvailable()) return;

    const toEmbed: Array<{ tool: ToolDefinition; text: string }> = [];
    for (const tool of tools) {
      const desc = tool.description ?? tool.name;
      const stored = this.vectorStore.getDescription(serverName, tool.name);
      if (stored !== desc) {
        toEmbed.push({ tool, text: `${tool.name}: ${desc}` });
      }
    }

    if (toEmbed.length === 0) return;

    const embeddings = await this.embedder.embedBatch(toEmbed.map(t => t.text));
    for (let i = 0; i < toEmbed.length; i++) {
      if (embeddings[i] && embeddings[i].length > 0) {
        this.vectorStore.upsert(
          serverName,
          toEmbed[i].tool.name,
          toEmbed[i].tool.description ?? toEmbed[i].tool.name,
          embeddings[i],
        );
      }
    }
  }

  removeServer(serverName: string): void {
    this.store.delete(serverName);
    this.vectorStore?.deleteServer(serverName);
  }

  getServerTools(serverName: string): ToolDefinition[] {
    return this.store.getIfCached(serverName) ?? [];
  }

  async ensureServer(serverName: string): Promise<ToolDefinition[]> {
    return this.store.get(serverName);
  }

  getAllTools(): ToolDefinition[] {
    const all: ToolDefinition[] = [];
    this.store.forEach((tools) => {
      all.push(...tools);
    });
    return all;
  }

  async search(query: string, server?: string, topN: number = DEFAULT_TOP_N, perceptionMode?: PerceptionMode): Promise<ToolMatch[]> {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return [];

    // Try hybrid search if vector store and embedder are available
    if (this.vectorStore && this.embedder?.isAvailable()) {
      try {
        const queryEmbedding = await this.embedder.embed(query);
        if (queryEmbedding.length > 0) {
          return this.hybridSearch(queryEmbedding, words, server, topN, perceptionMode);
        }
      } catch {
        // Fall through to keyword-only
      }
    }

    return this.keywordSearch(words, server, topN);
  }

  /** Synchronous keyword-only search (original algorithm, no regression). */
  keywordSearch(words: string[], server?: string, topN: number = DEFAULT_TOP_N): ToolMatch[] {
    const source = server
      ? (this.store.getIfCached(server) ?? [])
      : this.getAllTools();

    const scored: ToolMatch[] = [];

    for (const tool of source) {
      let score = 0;
      const nameLower = tool.name.toLowerCase();
      const descLower = (tool.description ?? '').toLowerCase();

      for (const word of words) {
        if (nameLower === word) {
          score += SCORE_EXACT_NAME;
        } else if (nameLower.includes(word)) {
          score += SCORE_NAME_CONTAINS;
        }
        if (descLower.includes(word)) {
          score += SCORE_DESC_CONTAINS;
        }
      }

      if (score > 0) {
        const maxPossible = words.length * (SCORE_EXACT_NAME + SCORE_DESC_CONTAINS);
        scored.push({
          tool,
          score,
          confidence: Math.min(score / maxPossible, 1),
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
  }

  private hybridSearch(
    queryEmbedding: Float32Array,
    words: string[],
    server?: string,
    topN: number = DEFAULT_TOP_N,
    perceptionMode?: PerceptionMode,
  ): ToolMatch[] {
    if (!this.vectorStore) return this.keywordSearch(words, server, topN);

    // Get vector similarity candidates
    const vectorResults = this.vectorStore.search(queryEmbedding, VECTOR_CANDIDATE_LIMIT);

    // Filter by server if specified
    const filtered: VectorSearchResult[] = server
      ? vectorResults.filter(r => r.server === server)
      : vectorResults;

    if (filtered.length === 0) {
      return this.keywordSearch(words, server, topN);
    }

    // Build a tool lookup from the catalog
    const allTools = server
      ? (this.store.getIfCached(server) ?? [])
      : this.getAllTools();
    const toolMap = new Map<string, ToolDefinition>();
    for (const tool of allTools) {
      toolMap.set(`${tool.server}:${tool.name}`, tool);
    }

    // Compute keyword scores for vector candidates
    const candidates: Array<{
      tool: ToolDefinition;
      semanticScore: number;
      keywordScore: number;
    }> = [];

    for (const vr of filtered) {
      const tool = toolMap.get(`${vr.server}:${vr.toolName}`);
      if (!tool) continue;

      let kwScore = 0;
      const nameLower = tool.name.toLowerCase();
      const descLower = (tool.description ?? '').toLowerCase();

      for (const word of words) {
        if (nameLower === word) {
          kwScore += SCORE_EXACT_NAME;
        } else if (nameLower.includes(word)) {
          kwScore += SCORE_NAME_CONTAINS;
        }
        if (descLower.includes(word)) {
          kwScore += SCORE_DESC_CONTAINS;
        }
      }

      candidates.push({
        tool,
        semanticScore: vr.similarity,
        keywordScore: kwScore,
      });
    }

    // Also include keyword-only matches not in vector results
    const vectorKeys = new Set(filtered.map(r => `${r.server}:${r.toolName}`));
    for (const tool of allTools) {
      const key = `${tool.server}:${tool.name}`;
      if (vectorKeys.has(key)) continue;

      let kwScore = 0;
      const nameLower = tool.name.toLowerCase();
      const descLower = (tool.description ?? '').toLowerCase();

      for (const word of words) {
        if (nameLower === word) {
          kwScore += SCORE_EXACT_NAME;
        } else if (nameLower.includes(word)) {
          kwScore += SCORE_NAME_CONTAINS;
        }
        if (descLower.includes(word)) {
          kwScore += SCORE_DESC_CONTAINS;
        }
      }

      if (kwScore > 0) {
        candidates.push({ tool, semanticScore: 0, keywordScore: kwScore });
      }
    }

    if (candidates.length === 0) return [];

    // Normalize score sets
    const semanticScores = normalize(candidates.map(c => c.semanticScore));
    const keywordScores = normalize(candidates.map(c => c.keywordScore));

    // Third tier: perception-boosted scores from batch cache
    const perceptionScores = perceptionMode?.isBatchReady
      ? this.searchByPerception(words, perceptionMode, server)
      : null;

    const use3Tier = perceptionScores !== null && perceptionScores.size > 0;

    // Look up raw perception scores for candidates, then normalize
    const rawPerception = candidates.map(c => {
      if (!perceptionScores) return 0;
      return perceptionScores.get(`${c.tool.server}:${c.tool.name}`) ?? 0;
    });
    const normPerception = use3Tier ? normalize(rawPerception) : rawPerception;

    // Combine: 3-tier when perception available, 2-tier otherwise
    const results: ToolMatch[] = candidates.map((c, i) => {
      const combined = use3Tier
        ? SEMANTIC_WEIGHT_3T * semanticScores[i] + KEYWORD_WEIGHT_3T * keywordScores[i] + PERCEPTION_WEIGHT * normPerception[i]
        : SEMANTIC_WEIGHT * semanticScores[i] + KEYWORD_WEIGHT * keywordScores[i];
      return {
        tool: c.tool,
        score: combined,
        confidence: Math.min(combined, 1),
      };
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topN);
  }

  /**
   * Third search tier: perception-boosted results from batch cache.
   * Maps query to domains via DOMAIN_KEYWORDS, filters batch cache by matching domains,
   * scores by domain match (10) + relevance score * 5.
   */
  searchByPerception(
    words: string[],
    perceptionMode: PerceptionMode,
    server?: string,
  ): Map<string, number> {
    const scores = new Map<string, number>();
    if (!perceptionMode.isBatchReady) return scores;

    // Map query words to matching domains
    const matchedDomains = new Set<string>();
    const domainMap = PerceptionMode.domainMap;
    for (const [domain, keywords] of Object.entries(domainMap)) {
      for (const word of words) {
        if (keywords.some(kw => kw.includes(word) || word.includes(kw))) {
          matchedDomains.add(domain);
        }
      }
    }

    // Score tools from batch cache
    const allTools = server
      ? (this.store.getIfCached(server) ?? [])
      : this.getAllTools();

    for (const tool of allTools) {
      const cacheKey = `${tool.server}.${tool.name}`;
      const cached = perceptionMode.getBatchClassification(cacheKey);
      if (!cached) continue;

      let score = 0;
      if (matchedDomains.has(cached.domain.label)) {
        score += 10; // domain match boost
      }
      score += cached.relevance.score * 5; // relevance contribution

      if (score > 0) {
        scores.set(`${tool.server}:${tool.name}`, score);
      }
    }

    return scores;
  }

  /** Classify a tool's domain via the perception provider (if available). */
  async classifyDomain(tool: ToolDefinition): Promise<PerceptionResult | null> {
    if (!this.perceptionProvider) return null;
    return this.perceptionProvider.classifyDomain(toArtifact(tool));
  }

  /** Score a tool's relevance to a query via the perception provider (if available). */
  async scoreRelevance(query: string, tool: ToolDefinition): Promise<PerceptionResult | null> {
    if (!this.perceptionProvider) return null;
    return this.perceptionProvider.scoreRelevance(query, toArtifact(tool));
  }

  getSummary(): Array<{ server: string; toolCount: number; tools: string[] }> {
    const summaries: Array<{ server: string; toolCount: number; tools: string[] }> = [];
    this.store.forEach((tools, server) => {
      summaries.push({
        server,
        toolCount: tools.length,
        tools: tools.map(t => t.name),
      });
    });
    return summaries;
  }

  get serverCount(): number {
    return this.store.size;
  }

  get totalToolCount(): number {
    let count = 0;
    this.store.forEach((tools) => {
      count += tools.length;
    });
    return count;
  }

  destroy(): void {
    this.store.destroy();
    try { this.vectorStore?.close(); } catch { /* already closed */ }
  }
}
