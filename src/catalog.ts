import type { ToolDefinition, ToolMatch } from './types.js';
import { Store } from './store.js';
import type { VectorStore, VectorSearchResult } from './vector-store.js';
import type { Embedder } from './embedder.js';

/**
 * Two-tier tool catalog with Store-backed caching and hybrid search.
 *
 * Hybrid search: semantic similarity + keyword scoring.
 *
 * Score formula: 0.6 * semantic + 0.4 * keyword (normalized)
 * Falls back to keyword-only when embeddings are unavailable.
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

export interface CatalogOptions {
  loader?: (serverName: string) => Promise<ToolDefinition[]>;
  vectorStore?: VectorStore;
  embedder?: Embedder;
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

  constructor(options?: CatalogOptions) {
    this.store = new Store<string, ToolDefinition[]>({
      loader: options?.loader ?? (async () => []),
      defaultTtlMs: CATALOG_TTL_MS,
    });
    this.store.startCleanup(CATALOG_CLEANUP_MS);
    this.vectorStore = options?.vectorStore ?? null;
    this.embedder = options?.embedder ?? null;
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

  async search(query: string, server?: string, topN: number = DEFAULT_TOP_N): Promise<ToolMatch[]> {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return [];

    // Try hybrid search if vector store and embedder are available
    if (this.vectorStore && this.embedder?.isAvailable()) {
      try {
        const queryEmbedding = await this.embedder.embed(query);
        if (queryEmbedding.length > 0) {
          return this.hybridSearch(queryEmbedding, words, server, topN);
        }
      } catch {
        // Fall through to keyword-only
      }
    }

    return this.keywordSearch(words, server, topN);
  }

  /** Synchronous keyword-only search (original algorithm). */
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
  ): ToolMatch[] {
    if (!this.vectorStore) return this.keywordSearch(words, server, topN);

    const candidateLimit = server ? VECTOR_CANDIDATE_LIMIT * 3 : VECTOR_CANDIDATE_LIMIT;
    const vectorResults = this.vectorStore.search(queryEmbedding, candidateLimit);

    const filtered: VectorSearchResult[] = server
      ? vectorResults.filter(r => r.server === server)
      : vectorResults;

    if (filtered.length === 0) {
      return this.keywordSearch(words, server, topN);
    }

    const allTools = server
      ? (this.store.getIfCached(server) ?? [])
      : this.getAllTools();
    const toolMap = new Map<string, ToolDefinition>();
    for (const tool of allTools) {
      toolMap.set(`${tool.server}:${tool.name}`, tool);
    }

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

    const semanticScores = normalize(candidates.map(c => c.semanticScore));
    const keywordScores = normalize(candidates.map(c => c.keywordScore));

    const results: ToolMatch[] = candidates.map((c, i) => {
      const combined = SEMANTIC_WEIGHT * semanticScores[i] + KEYWORD_WEIGHT * keywordScores[i];
      return {
        tool: c.tool,
        score: combined,
        confidence: Math.min(combined, 1),
      };
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topN);
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
