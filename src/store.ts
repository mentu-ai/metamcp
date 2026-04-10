/**
 * Generic Store with lazy loading, TTL-based eviction, and periodic cleanup.
 *
 * Lifecycle: new → get(key) → lazy_load → cache → startCleanup → cleanup
 *
 * JS is single-threaded — no locks needed. Async get() serializes loads
 * via the event loop. setInterval handles periodic cleanup.
 */

export interface CacheEntry<V> {
  value: V;
  lastAccessed: Date;
  expiresAt: Date | null;
}

export interface StoreOptions<K, V> {
  loader: (key: K) => Promise<V>;
  disposer?: (key: K, value: V) => void;
  defaultTtlMs?: number;
  retentionWindowMs?: number;
}

export class Store<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private loader: (key: K) => Promise<V>;
  private disposer?: (key: K, value: V) => void;
  private defaultTtlMs: number | null;
  private retentionWindowMs: number | null;

  /**
   * In-flight load promises — singleton pattern.
   * Prevents concurrent callers from triggering duplicate loads for the same key.
   */
  private pendingLoads = new Map<K, Promise<V>>();

  constructor(options: StoreOptions<K, V>) {
    this.loader = options.loader;
    this.disposer = options.disposer;
    this.defaultTtlMs = options.defaultTtlMs ?? null;
    this.retentionWindowMs = options.retentionWindowMs ?? null;
  }

  async get(key: K): Promise<V> {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccessed = new Date();
      return entry.value;
    }

    // Singleton: if a load is already in-flight for this key, await it
    const pending = this.pendingLoads.get(key);
    if (pending) return pending;

    const promise = this.loader(key);
    this.pendingLoads.set(key, promise);

    try {
      const value = await promise;
      // Cache only on success — loader errors must not corrupt cache
      this.set(key, value);
      return value;
    } finally {
      this.pendingLoads.delete(key);
    }
  }

  set(key: K, value: V, ttlMs?: number): void {
    const now = new Date();
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.cache.set(key, {
      value,
      lastAccessed: now,
      expiresAt: ttl !== null ? new Date(now.getTime() + ttl) : null,
    });
  }

  delete(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    this.cache.delete(key);
    this.disposer?.(key, entry.value);
    return true;
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  /** Get cached value without triggering loader or updating lastAccessed. */
  getIfCached(key: K): V | undefined {
    return this.cache.get(key)?.value;
  }

  /** Update lastAccessed without triggering loader. */
  touch(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    entry.lastAccessed = new Date();
    return true;
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  get size(): number {
    return this.cache.size;
  }

  /** Iterate all cached entries. */
  forEach(fn: (value: V, key: K) => void): void {
    for (const [key, entry] of this.cache) {
      fn(entry.value, key);
    }
  }

  startCleanup(intervalMs: number): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs);
    this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      let evict = false;

      // TTL expired
      if (entry.expiresAt !== null && now > entry.expiresAt.getTime()) {
        evict = true;
      }

      // Retention window exceeded (not accessed recently enough)
      if (this.retentionWindowMs !== null && now - entry.lastAccessed.getTime() > this.retentionWindowMs) {
        evict = true;
      }

      if (evict) {
        this.cache.delete(key);
        try {
          this.disposer?.(key, entry.value);
        } catch (err) {
          console.error(`Store cleanup: disposer failed for key=${String(key)}`, err);
        }
      }
    }
  }

  destroy(): void {
    this.stopCleanup();
    for (const [key, entry] of this.cache) {
      try {
        this.disposer?.(key, entry.value);
      } catch (err) {
        console.error(`Store destroy: disposer failed for key=${String(key)}`, err);
      }
    }
    this.cache.clear();
  }
}
