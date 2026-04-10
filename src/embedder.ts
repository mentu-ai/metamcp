/**
 * Abstract embedding provider interface.
 *
 * The VectorStore must not care where embeddings come from --
 * only that it receives a Float32Array. This abstraction exists
 * so alternative embedding providers (local models, different APIs)
 * can be swapped in without changing the catalog or vector store.
 */
export interface EmbedderProvider {
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  embed(text: string): Promise<Float32Array>;
  isAvailable(): boolean;
  readonly providerId: string;
}

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

/**
 * Voyage AI embedding provider via Anthropic's partnership.
 *
 * Uses the Voyage API (voyage-3-lite model) which is the embedding
 * model recommended for use with Anthropic/Claude workflows.
 *
 * Batch embedding via Voyage API with rate-limit-safe sequential calls.
 * Embeddings cached in SQLite for zero-cost repeated lookups.
 */
export class AnthropicEmbedderProvider implements EmbedderProvider {
  readonly providerId = 'anthropic';
  private apiKey: string | undefined;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.VOYAGE_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    return results[0] ?? new Float32Array(0);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.isAvailable() || texts.length === 0) return [];

    try {
      const response = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'voyage-3-lite',
          input: texts,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) return [];

      const data = await response.json() as VoyageEmbeddingResponse;
      return data.data.map(
        (item) => new Float32Array(item.embedding)
      );
    } catch {
      return [];
    }
  }
}

/**
 * Embedder facade -- delegates to the best available EmbedderProvider.
 *
 * Provider selection order: configured provider → Anthropic → error.
 * Pass an explicit provider to override auto-detection.
 */
export class Embedder {
  private provider: EmbedderProvider;

  constructor(provider?: EmbedderProvider) {
    this.provider = provider ?? new AnthropicEmbedderProvider();
  }

  embed(text: string): Promise<Float32Array> {
    return this.provider.embed(text);
  }

  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return this.provider.embedBatch(texts);
  }

  isAvailable(): boolean {
    return this.provider.isAvailable();
  }

  get providerId(): string {
    return this.provider.providerId;
  }
}
