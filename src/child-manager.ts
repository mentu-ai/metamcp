import { EventEmitter } from 'node:events';
import { ConnectionState, canTransition, DEFAULT_POOL_CONFIG } from './types.js';
import type { ServerConfig, ChildState, ToolDefinition, PoolConfig } from './types.js';
import { McpClient } from './mcp-client.js';
import { ToolCatalog } from './catalog.js';
import type { CatalogOptions } from './catalog.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { log } from './log.js';

const MAX_CHILDREN = 1024;
const SHUTDOWN_INITIAL_MS = 50;
const SIGKILL_THRESHOLD_MS = 1001;

interface ManagedChild {
  config: ServerConfig;
  client: McpClient;
  state: ConnectionState;
  pid?: number;
  restartCount: number;
  idleSince: number;
  circuitBreaker: CircuitBreaker;
}

export class ChildManager extends EventEmitter {
  private children = new Map<string, ManagedChild>();
  private catalog: ToolCatalog;
  private pool: PoolConfig;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Idle list — LIFO ordered.
   *
   * New idle children inserted at HEAD (index 0) — most recently idled.
   * Eviction removes from TAIL (last element) — oldest idle evicted first.
   */
  private idleList: string[] = [];

  constructor(poolConfig?: Partial<PoolConfig>, catalogOptions?: CatalogOptions) {
    super();
    this.pool = { ...DEFAULT_POOL_CONFIG, ...poolConfig };
    this.catalog = new ToolCatalog(catalogOptions);
    this.startIdleSweep();
  }

  private setState(child: ManagedChild, newState: ConnectionState): void {
    if (!canTransition(child.state, newState)) {
      log('warn', 'invalid state transition', {
        server: child.config.name,
        from: child.state,
        to: newState,
      });
      return;
    }

    const oldState = child.state;
    child.state = newState;

    // Maintain idle list ordering (LIFO: insert at HEAD)
    if (newState === ConnectionState.IDLE && oldState !== ConnectionState.IDLE) {
      child.idleSince = Date.now();
      // Remove if already in list (shouldn't happen, but defensive)
      const idx = this.idleList.indexOf(child.config.name);
      if (idx !== -1) this.idleList.splice(idx, 1);
      // Insert at HEAD (index 0) — LIFO
      this.idleList.unshift(child.config.name);
    } else if (oldState === ConnectionState.IDLE && newState !== ConnectionState.IDLE) {
      // Remove from idle list when leaving IDLE
      const idx = this.idleList.indexOf(child.config.name);
      if (idx !== -1) this.idleList.splice(idx, 1);
    }
  }

  async spawn(config: ServerConfig): Promise<ToolDefinition[]> {
    if (this.children.size >= MAX_CHILDREN) {
      throw new Error(`Max children (${MAX_CHILDREN}) reached`);
    }

    const existing = this.children.get(config.name);
    if (existing && existing.state !== ConnectionState.CLOSED && existing.state !== ConnectionState.FAILED) {
      if (existing.state === ConnectionState.IDLE || existing.state === ConnectionState.ACTIVE) {
        return this.catalog.getServerTools(config.name);
      }
    }

    // Pool upper bound check
    // Upper bound = pool_size + res_pool_size
    const activeCount = this.getActiveChildCount();
    const upperBound = this.pool.poolSize + this.pool.resPoolSize;
    if (activeCount >= upperBound) {
      // Try to evict an idle child to make room
      const evicted = this.evictPoolConnection();
      if (!evicted) {
        throw new Error(`Pool upper bound (${upperBound}) reached, no idle children to evict`);
      }
    }

    const client = new McpClient(config);
    const child: ManagedChild = {
      config,
      client,
      state: ConnectionState.IDLE,
      restartCount: existing?.restartCount ?? 0,
      idleSince: 0,
      circuitBreaker: existing?.circuitBreaker ?? new CircuitBreaker(this.pool.failureThreshold, this.pool.cooldownMs),
    };

    this.children.set(config.name, child);
    this.setState(child, ConnectionState.CONNECTING);

    try {
      await client.connect();
      this.setState(child, ConnectionState.ACTIVE);
      const tools = await client.listTools();
      this.catalog.registerServer(config.name, tools);
      this.setState(child, ConnectionState.IDLE);
      return tools;
    } catch (err) {
      this.setState(child, ConnectionState.FAILED);
      throw err;
    }
  }

  async ensureConnected(name: string): Promise<void> {
    const child = this.children.get(name);
    if (!child) throw new Error(`Unknown server: ${name}`);

    if (child.state === ConnectionState.IDLE) return;

    if (child.state === ConnectionState.FAILED || child.state === ConnectionState.CLOSED) {
      if (child.config.criticality === 'vital' || child.restartCount === 0) {
        child.restartCount++;
        // spawn() sees FAILED/CLOSED, creates a fresh child (no state bypass)
        await this.spawn(child.config);
      } else {
        throw new Error(`Server ${name} is ${child.state} and max restarts exceeded`);
      }
    }
  }

  async callTool(serverName: string, toolName: string, args?: Record<string, unknown>): Promise<unknown> {
    // Circuit breaker check
    const cbChild = this.children.get(serverName);
    if (cbChild?.circuitBreaker.isOpen()) {
      throw new Error(`Circuit breaker open for ${serverName} — cooldown ${this.pool.cooldownMs}ms`);
    }

    await this.ensureConnected(serverName);

    // Get child AFTER ensureConnected — it may have created a fresh one
    const child = this.children.get(serverName);
    if (!child) throw new Error(`Unknown server: ${serverName}`);

    this.setState(child, ConnectionState.ACTIVE);
    try {
      const result = await child.client.callTool(toolName, args);
      this.setState(child, ConnectionState.IDLE);
      child.circuitBreaker.recordSuccess();
      return result;
    } catch (err) {
      this.setState(child, ConnectionState.FAILED);
      child.circuitBreaker.recordFailure();

      // Retry once on crash (spawn → retry)
      if (child.config.criticality === 'vital' || child.restartCount < 1) {
        child.restartCount++;
        try {
          await this.spawn(child.config);
          const fresh = this.children.get(serverName);
          if (!fresh) throw err;
          this.setState(fresh, ConnectionState.ACTIVE);
          const result = await fresh.client.callTool(toolName, args);
          this.setState(fresh, ConnectionState.IDLE);
          fresh.circuitBreaker.recordSuccess();
          return result;
        } catch {
          const failed = this.children.get(serverName);
          if (failed) this.setState(failed, ConnectionState.FAILED);
          this.children.get(serverName)?.circuitBreaker.recordFailure();
          throw err;
        }
      }
      throw err;
    }
  }

  /**
   * Graceful shutdown sequence with escalating signals.
   *
   * 1. Close child's stdin (stops accepting new requests)
   * 2. Wait 50ms initial delay
   * 3. Send SIGTERM while timer < 1001ms
   * 4. Double the timer on each attempt
   * 5. Send SIGKILL when timer >= 1001ms
   *
   * If stdin close fails, fall back to process.kill() directly.
   *
   * Timer progression: 50→100→200→400→800→SIGKILL (~1550ms total)
   */
  async shutdown(name: string): Promise<void> {
    const child = this.children.get(name);
    if (!child) return;

    if (child.state === ConnectionState.CLOSED) return;

    const pid = child.client.pid;

    // Step 1: Close stdin
    // Channel fallback: if stdin close fails, fall back to direct signal
    const channelClosed = child.client.closeStdin();
    if (!channelClosed && pid !== null) {
      this.sendSignal(pid, 'SIGTERM');
    }

    // Detach from SDK transport (we manage the process lifecycle now)
    child.client.detach();

    // Step 2-5: Escalating signal pattern
    if (pid !== null) {
      let timer = SHUTDOWN_INITIAL_MS; // 50ms

      // Wait initial delay before first signal check
      await this.delay(timer);

      while (this.isProcessAlive(pid)) {
        if (timer >= SIGKILL_THRESHOLD_MS) {
          // Timer >= 1001ms → SIGKILL
          this.sendSignal(pid, 'SIGKILL');
          break;
        }

        // Send SIGTERM
        this.sendSignal(pid, 'SIGTERM');

        // Double timer
        timer <<= 1;
        await this.delay(timer);
      }
    }

    this.setState(child, ConnectionState.CLOSED);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private sendSignal(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited — ignore
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async shutdownAll(): Promise<void> {
    this.stopIdleSweep();
    const shutdowns = Array.from(this.children.keys()).map(name => this.shutdown(name));
    await Promise.allSettled(shutdowns);
  }

  /** Synchronous kill of all child PIDs — last resort on crash. */
  killAllSync(): void {
    for (const child of this.children.values()) {
      if (child.pid) {
        try { process.kill(child.pid, 'SIGKILL'); } catch { /* already dead */ }
      }
    }
  }

  /**
   * Idle sweep. Evicts connections idle longer than idleTimeoutMs every 60s.
   */
  private startIdleSweep(): void {
    if (this.sweepTimer) return;
    const SWEEP_INTERVAL_MS = 60_000;
    this.sweepTimer = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private stopIdleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Sweep idle connections.
   *
   * Guard: only evict if minPoolSize == 0 OR activeCount > minPoolSize.
   */
  private sweepIdle(): void {
    const now = Date.now();
    const cutoff = now - this.pool.idleTimeoutMs;
    for (let i = this.idleList.length - 1; i >= 0; i--) {
      // min_pool_size guard
      if (this.pool.minPoolSize > 0 && this.getActiveChildCount() <= this.pool.minPoolSize) {
        break;
      }
      const name = this.idleList[i];
      const child = this.children.get(name);
      if (!child) {
        this.idleList.splice(i, 1);
        continue;
      }
      if (child.idleSince > 0 && child.idleSince < cutoff) {
        log('info', 'idle timeout eviction', { server: name, idleSince: child.idleSince });
        this.setState(child, ConnectionState.CLOSED);
        child.client.detach();
        this.catalog.removeServer(name);
      }
    }
  }

  /** Count active (non-CLOSED, non-FAILED) children. */
  private getActiveChildCount(): number {
    let count = 0;
    for (const child of this.children.values()) {
      if (child.state !== ConnectionState.CLOSED && child.state !== ConnectionState.FAILED) {
        count++;
      }
    }
    return count;
  }

  /**
   * Evict one idle connection.
   *
   * Contract: LIFO insert at HEAD + evict from TAIL = oldest idle evicted first.
   * Single connection per call (no batch). Disconnect reason: "evicted".
   *
   * Returns true if a connection was evicted, false if idle list is empty.
   */
  private evictPoolConnection(): boolean {
    if (this.idleList.length === 0) return false;

    // Evict from TAIL (oldest idle — LRU)
    const name = this.idleList[this.idleList.length - 1];
    const child = this.children.get(name);
    if (!child) {
      // Stale entry — clean up and retry
      this.idleList.pop();
      return this.evictPoolConnection();
    }

    log('info', 'evicting idle connection', {
      server: name,
      reason: 'evicted',
      idleSince: child.idleSince,
    });

    // Transition to CLOSED (removes from idle list via setState)
    this.setState(child, ConnectionState.CLOSED);
    child.client.detach();
    this.catalog.removeServer(name);
    return true;
  }

  /**
   * Pool sizing enforcement.
   *
   * Upper bound: if count > poolSize + resPoolSize → evict idle children.
   * Lower bound: if count < minPoolSize → needs launch (caller handles).
   *
   * Reserve capacity only available when a request has been waiting >= resPoolTimeout.
   */
  enforcePoolBounds(): { evicted: number; belowMinimum: boolean } {
    let evicted = 0;
    const upperBound = this.pool.poolSize + this.pool.resPoolSize;

    // Upper bound enforcement: evict excess idle children
    while (this.getActiveChildCount() > upperBound && this.idleList.length > 0) {
      if (this.evictPoolConnection()) {
        evicted++;
      } else {
        break;
      }
    }

    if (evicted > 0) {
      log('info', 'pool sizing enforcement', {
        evicted,
        activeCount: this.getActiveChildCount(),
        upperBound,
      });
    }

    // Lower bound check (caller is responsible for launching)
    const belowMinimum = this.getActiveChildCount() < this.pool.minPoolSize;

    return { evicted, belowMinimum };
  }

  /**
   * Check if reserve pool capacity is available.
   *
   * Reserve pool activates only when:
   * - resPoolTimeout > 0 AND resPoolSize > 0
   * - AND the request has been waiting >= resPoolTimeout
   *
   * Returns true if the request may use reserve capacity.
   */
  isReservePoolAvailable(waitingSinceMs: number): boolean {
    if (this.pool.resPoolSize <= 0 || this.pool.resPoolTimeout <= 0) return false;
    const waited = Date.now() - waitingSinceMs;
    return waited >= this.pool.resPoolTimeout;
  }

  /**
   * Get current pool sizing status.
   */
  getPoolStatus(): {
    activeCount: number;
    idleCount: number;
    poolSize: number;
    upperBound: number;
    minPoolSize: number;
    belowMinimum: boolean;
  } {
    const activeCount = this.getActiveChildCount();
    const upperBound = this.pool.poolSize + this.pool.resPoolSize;
    return {
      activeCount,
      idleCount: this.idleList.length,
      poolSize: this.pool.poolSize,
      upperBound,
      minPoolSize: this.pool.minPoolSize,
      belowMinimum: activeCount < this.pool.minPoolSize,
    };
  }

  getServerState(name: string): ChildState | undefined {
    const child = this.children.get(name);
    if (!child) return undefined;
    return {
      name: child.config.name,
      state: child.state,
      pid: child.pid,
      toolCount: this.catalog.getServerTools(child.config.name).length,
      criticality: child.config.criticality,
      restartCount: child.restartCount,
    };
  }

  getAllStates(): ChildState[] {
    return Array.from(this.children.values()).map(child => ({
      name: child.config.name,
      state: child.state,
      pid: child.pid,
      toolCount: this.catalog.getServerTools(child.config.name).length,
      criticality: child.config.criticality,
      restartCount: child.restartCount,
    }));
  }

  getCatalog(): ToolCatalog {
    return this.catalog;
  }

  getServerNames(): string[] {
    return Array.from(this.children.keys());
  }

  hasServer(name: string): boolean {
    return this.children.has(name);
  }
}
