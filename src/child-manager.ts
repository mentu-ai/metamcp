import { EventEmitter } from 'node:events';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ConnectionState, canTransition, DEFAULT_POOL_CONFIG } from './types.js';
import type { ServerConfig, ChildState, ToolDefinition, PoolConfig } from './types.js';
import { McpClient } from './mcp-client.js';
import type { ElicitationCallback } from './mcp-client.js';
import { MCPConnectionFSM } from './connection-fsm.js';
import { ToolCatalog, type CatalogOptions } from './catalog.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { Store } from './store.js';
import { log } from './log.js';
import { analyzeConnectionError, isAuthIssue, isTransientIssue } from './error-classifier.js';
import { readSchemaCache, writeSchemaCache, isCacheStale } from './schema-cache.js';

const MAX_CHILDREN = 1024;
const SHUTDOWN_INITIAL_MS = 50;
const SIGKILL_THRESHOLD_MS = 1001;
const CLEANUP_INTERVAL_MS = 60_000;

export interface ManagedChild {
  config: ServerConfig;
  client: McpClient;
  fsm: MCPConnectionFSM;
  state: ConnectionState;
  pid?: number;
  restartCount: number;
  idleSince: number;
  circuitBreaker: CircuitBreaker;
}

export type SpawnFailureHook = (config: ServerConfig, error: Error) => Promise<boolean>;

export class ChildManager extends EventEmitter {
  private connectionStore: Store<string, ManagedChild>;
  private configs = new Map<string, ServerConfig>();
  private spawnCarryover = new Map<string, { restartCount: number; circuitBreaker: CircuitBreaker }>();
  private catalog: ToolCatalog;
  private pool: PoolConfig;
  private elicitationCallback: ElicitationCallback | null;
  private spawnFailureHook: SpawnFailureHook | null = null;

  /**
   * Idle list — LIFO ordered.
   *
   * New idle children inserted at HEAD (index 0) — most recently idled.
   * Eviction removes from TAIL (last element) — oldest idle evicted first.
   */
  private idleList: string[] = [];

  constructor(
    poolConfig?: Partial<PoolConfig>,
    catalogOptions?: Omit<CatalogOptions, 'loader'>,
    elicitationCallback?: ElicitationCallback,
  ) {
    super();
    this.elicitationCallback = elicitationCallback ?? null;
    this.pool = { ...DEFAULT_POOL_CONFIG, ...poolConfig };
    this.catalog = new ToolCatalog({
      loader: async (serverName: string) => {
        const child = this.connectionStore.getIfCached(serverName);
        if (!child) throw new Error(`No connection for server: ${serverName}`);
        return child.client.listTools();
      },
      ...catalogOptions,
    });
    this.connectionStore = new Store<string, ManagedChild>({
      loader: async (name: string) => {
        const config = this.configs.get(name);
        if (!config) throw new Error(`No config for server: ${name}`);
        return this.doSpawn(config);
      },
      disposer: (_name: string, child: ManagedChild) => {
        log('info', 'store eviction', { server: child.config.name, state: child.state });
        child.fsm.disconnect();
        if (child.state !== ConnectionState.CLOSED) {
          this.setState(child, ConnectionState.CLOSED);
        }
        child.client.detach();
        this.catalog.removeServer(child.config.name);
      },
      retentionWindowMs: this.pool.idleTimeoutMs,
    });
    this.connectionStore.startCleanup(CLEANUP_INTERVAL_MS);
  }

  /** Register a hook called on spawn failure. Returns true if heal succeeded → triggers one retry. */
  onSpawnFailure(hook: SpawnFailureHook): void {
    this.spawnFailureHook = hook;
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
    const existing = this.connectionStore.getIfCached(config.name);
    if (existing && existing.state !== ConnectionState.CLOSED && existing.state !== ConnectionState.FAILED) {
      if (existing.state === ConnectionState.IDLE || existing.state === ConnectionState.ACTIVE) {
        this.connectionStore.touch(config.name);
        return this.catalog.getServerTools(config.name);
      }
    }

    // Remove stale entry for re-spawn, preserving carryover state
    if (existing && (existing.state === ConnectionState.CLOSED || existing.state === ConnectionState.FAILED)) {
      this.spawnCarryover.set(config.name, {
        restartCount: existing.restartCount,
        circuitBreaker: existing.circuitBreaker,
      });
      this.connectionStore.delete(config.name);
    }

    if (this.connectionStore.size >= MAX_CHILDREN) {
      throw new Error(`Max children (${MAX_CHILDREN}) reached`);
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

    // Store config for loader, then lazy-load via Store (handles singleton dedup)
    this.configs.set(config.name, config);
    await this.connectionStore.get(config.name);
    return this.catalog.getServerTools(config.name);
  }

  private async doSpawn(config: ServerConfig): Promise<ManagedChild> {
    const carryover = this.spawnCarryover.get(config.name);
    this.spawnCarryover.delete(config.name);

    const client = new McpClient(config);
    if (this.elicitationCallback) {
      client.onElicitation(this.elicitationCallback);
    }

    // Connection FSM for reconnection resilience (mirrors CC's xf8 class)
    const fsm = new MCPConnectionFSM({ name: config.name });

    const child: ManagedChild = {
      config,
      client,
      fsm,
      state: ConnectionState.IDLE,
      restartCount: carryover?.restartCount ?? 0,
      idleSince: 0,
      circuitBreaker: carryover?.circuitBreaker ?? new CircuitBreaker(this.pool.failureThreshold, this.pool.cooldownMs),
    };

    // Reconnection function: creates fresh client, connects, re-registers tools
    fsm.setConnectFn(async () => {
      try { await child.client.disconnect(); } catch { /* old client may be dead */ }
      const reconnClient = new McpClient(config);
      if (this.elicitationCallback) {
        reconnClient.onElicitation(this.elicitationCallback);
      }
      await reconnClient.connect();
      const tools = await reconnClient.listTools();
      await this.catalog.registerServerWithEmbeddings(config.name, tools);
      this.persistRegistry(config.name, tools.length, 'ok');
      child.client = reconnClient;
    });

    // FSM event wiring
    fsm.on('stateChange', ({ server, from, to, timestamp }: { server: string; from: string; to: string; timestamp: number }) => {
      log('info', 'connection fsm', { server, from, to });
      // CIR signal on degraded states
      if (to === 'disconnected' || to === 'reconnecting') {
        process.stderr.write(JSON.stringify({
          type: 'cir_signal',
          kind: 'mcp_connection',
          body: `${server}: ${from} \u2192 ${to}`,
          confidence: 1.0,
          timestamp,
        }) + '\n');
      }
      // On successful reconnection, restore pool state
      if (to === 'connected' && from === 'reconnecting') {
        if (child.state === ConnectionState.FAILED) {
          this.setState(child, ConnectionState.CONNECTING);
        }
        if (child.state === ConnectionState.CONNECTING) {
          this.setState(child, ConnectionState.ACTIVE);
        }
        if (child.state === ConnectionState.ACTIVE) {
          this.setState(child, ConnectionState.IDLE);
        }
        this.emit('server-reconnected', config.name);
      }
    });

    fsm.on('exhausted', ({ server, attempts }: { server: string; attempts: number }) => {
      log('warn', 'connection fsm exhausted', { server, attempts });
      this.persistRegistry(config.name, 0, 'exhausted');
    });

    fsm.on('reconnecting', ({ server, attempt, delay }: { server: string; attempt: number; delay: number }) => {
      log('info', 'connection fsm reconnecting', { server, attempt, delay });
    });

    // Load cached schemas for instant catalog population before connect
    const cached = readSchemaCache(config.name);
    if (cached) {
      await this.catalog.registerServerWithEmbeddings(config.name, cached.tools);
      log('info', 'loaded schema cache', { server: config.name, tools: cached.tools.length });
    }

    this.setState(child, ConnectionState.CONNECTING);

    try {
      await client.connect();
      this.setState(child, ConnectionState.ACTIVE);
      const tools = await client.listTools();
      await this.catalog.registerServerWithEmbeddings(config.name, tools);
      // Update disk cache if stale or missing
      if (!cached || isCacheStale(cached.tools, tools)) {
        writeSchemaCache(config.name, tools);
      }
      this.persistRegistry(config.name, tools.length, 'ok');
      this.setState(child, ConnectionState.IDLE);
      fsm.notifyConnected();
      this.emit('server-connected', config.name, tools);
      return child;
    } catch (err) {
      // Cortex auto-heal: diagnose + attempt fix + one retry
      if (this.spawnFailureHook) {
        try {
          const healed = await this.spawnFailureHook(config, err as Error);
          if (healed) {
            // Respect circuit breaker — don't retry if tripped
            if (child.circuitBreaker.isOpen()) {
              log('warn', 'cortex healer: heal succeeded but circuit breaker open, skipping retry', { server: config.name });
            } else {
              // Retry inner spawn logic once after heal
              try {
                const retryClient = new McpClient(config);
                if (this.elicitationCallback) retryClient.onElicitation(this.elicitationCallback);
                child.client = retryClient;
                this.setState(child, ConnectionState.FAILED);
                this.setState(child, ConnectionState.CONNECTING);
                await retryClient.connect();
                this.setState(child, ConnectionState.ACTIVE);
                const tools = await retryClient.listTools();
                await this.catalog.registerServerWithEmbeddings(config.name, tools);
                this.persistRegistry(config.name, tools.length, 'ok');
                this.setState(child, ConnectionState.IDLE);
                this.emit('server-connected', config.name, tools);
                log('info', 'cortex healer: retry succeeded', { server: config.name });
                return child;
              } catch {
                // Heal retry also failed — fall through to FAILED
                log('warn', 'cortex healer: retry failed', { server: config.name });
              }
            }
          }
        } catch (hookErr) {
          log('warn', 'spawn failure hook error', { server: config.name, error: hookErr instanceof Error ? hookErr.message : String(hookErr) });
        }
      }

      this.persistRegistry(config.name, 0, 'failed');
      this.setState(child, ConnectionState.FAILED);
      throw err;
    }
  }

  async ensureConnected(name: string): Promise<void> {
    const child = this.connectionStore.getIfCached(name);
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
    const cbChild = this.connectionStore.getIfCached(serverName);
    if (cbChild?.circuitBreaker.isOpen()) {
      throw new Error(`Circuit breaker open for ${serverName} — cooldown ${this.pool.cooldownMs}ms`);
    }

    await this.ensureConnected(serverName);
    this.connectionStore.touch(serverName);

    // Get child AFTER ensureConnected — it may have created a fresh one
    const child = this.connectionStore.getIfCached(serverName);
    if (!child) throw new Error(`Unknown server: ${serverName}`);

    this.setState(child, ConnectionState.ACTIVE);
    try {
      const result = await child.client.callTool(toolName, args);
      this.setState(child, ConnectionState.IDLE);
      child.circuitBreaker.recordSuccess();
      return result;
    } catch (err) {
      const classification = analyzeConnectionError(err);
      this.setState(child, ConnectionState.FAILED);

      if (isAuthIssue(classification)) {
        // Auth errors should NOT trip circuit breaker — they won't fix on retry
        log('warn', `auth issue on ${serverName}`, { message: classification.rawMessage });
      } else if (isTransientIssue(classification)) {
        // Only transient errors count toward circuit breaker
        child.circuitBreaker.recordFailure();
      } else {
        // Unknown errors — record failure
        child.circuitBreaker.recordFailure();
      }

      // Retry once on crash (spawn → retry)
      if (child.config.criticality === 'vital' || child.restartCount < 1) {
        child.restartCount++;
        try {
          await this.spawn(child.config);
          const fresh = this.connectionStore.getIfCached(serverName);
          if (!fresh) throw err;
          this.setState(fresh, ConnectionState.ACTIVE);
          const result = await fresh.client.callTool(toolName, args);
          this.setState(fresh, ConnectionState.IDLE);
          fresh.circuitBreaker.recordSuccess();
          return result;
        } catch {
          // Immediate retry failed — trigger FSM background reconnection
          const failed = this.connectionStore.getIfCached(serverName);
          if (failed) {
            this.setState(failed, ConnectionState.FAILED);
            failed.fsm.onDisconnect();
          }
          throw err;
        }
      }

      // No immediate retry — trigger FSM background reconnection
      child.fsm.onDisconnect();
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
    const child = this.connectionStore.getIfCached(name);
    if (!child) return;

    if (child.state === ConnectionState.CLOSED) return;

    // Remote servers (HTTP/SSE): just disconnect — no PID to signal
    if (child.client.isRemote) {
      await child.client.disconnect();
      this.setState(child, ConnectionState.CLOSED);
      return;
    }

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
    // Remove from store (disposer is idempotent for already-CLOSED children)
    this.connectionStore.delete(name);
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
    this.catalog.destroy();
    this.connectionStore.stopCleanup();
    const names = Array.from(this.connectionStore.keys());
    await Promise.allSettled(names.map(name => this.shutdown(name)));
  }

  /** Count active (non-CLOSED, non-FAILED) children. */
  private getActiveChildCount(): number {
    let count = 0;
    this.connectionStore.forEach((child) => {
      if (child.state !== ConnectionState.CLOSED && child.state !== ConnectionState.FAILED) {
        count++;
      }
    });
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
    const child = this.connectionStore.getIfCached(name);
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

    // Store.delete triggers disposer: setState(CLOSED) + detach + catalog.removeServer
    this.connectionStore.delete(name);
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
    const child = this.connectionStore.getIfCached(name);
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
    const states: ChildState[] = [];
    this.connectionStore.forEach((child) => {
      states.push({
        name: child.config.name,
        state: child.state,
        pid: child.pid,
        toolCount: this.catalog.getServerTools(child.config.name).length,
        criticality: child.config.criticality,
        restartCount: child.restartCount,
      });
    });
    return states;
  }

  getHealth(): { status: string; servers: Record<string, unknown> } {
    const servers: Record<string, unknown> = {};
    let allConnected = true;

    this.connectionStore.forEach((child) => {
      const fsmState = child.fsm.toJSON();
      servers[child.config.name] = fsmState;
      if (fsmState.state !== 'connected') {
        allConnected = false;
      }
    });

    return {
      status: allConnected ? 'healthy' : 'degraded',
      servers,
    };
  }

  getCatalog(): ToolCatalog {
    return this.catalog;
  }

  getServerNames(): string[] {
    return Array.from(this.connectionStore.keys());
  }

  hasServer(name: string): boolean {
    return this.connectionStore.has(name);
  }

  getIdleList(): string[] {
    return [...this.idleList];
  }

  /**
   * Synchronous kill-all for process exit handler.
   * Called from process.on('exit') — no async allowed.
   * SIGKILL every known child PID immediately.
   */
  killAllSync(): void {
    this.connectionStore.forEach((child) => {
      const pid = child.client.pid;
      if (pid && pid > 0) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }
    });
  }

  /**
   * Get all known child PIDs (for external cleanup).
   */
  getAllPids(): number[] {
    const pids: number[] = [];
    this.connectionStore.forEach((child) => {
      const pid = child.client.pid;
      if (pid && pid > 0) pids.push(pid);
    });
    return pids;
  }

  /** Test-only: inject a pre-built ManagedChild into the store and idle list. */
  _injectTestChild(name: string, child: ManagedChild): void {
    this.configs.set(name, child.config);
    this.connectionStore.set(name, child);
    if (child.state === ConnectionState.IDLE) {
      child.idleSince = Date.now();
      const idx = this.idleList.indexOf(name);
      if (idx !== -1) this.idleList.splice(idx, 1);
      this.idleList.unshift(name);
    }
  }

  // ─── Registry Persistence ──────────────────────────────────────────────────

  private static readonly DOMAIN_MAP: Record<string, string> = {
    neon: 'database', postgres: 'database',
    spectre: 'binary_analysis', ghidra: 'reverse_engineering',
    crawlio: 'web_crawling', 'crawlio-browser': 'browser_automation',
    'crawlio-agent-headless': 'browser_automation',
    playwright: 'browser_automation', sentry: 'monitoring',
    airtable: 'project_management', mentu: 'project_management',
    xcodebuildmcp: 'development', context7: 'documentation',
  };

  /**
   * Persist server metadata to ~/.mentu/metamcp-registry.json.
   * Called on every successful connect and on circuit breaker trip.
   * Non-blocking — errors are logged, never thrown.
   */
  private persistRegistry(serverName: string, toolCount: number, health: string): void {
    try {
      const dir = join(homedir(), '.mentu');
      const registryPath = join(dir, 'metamcp-registry.json');

      let registry: Record<string, Record<string, unknown>> = {};
      try {
        if (existsSync(registryPath)) {
          registry = JSON.parse(readFileSync(registryPath, 'utf-8')) as Record<string, Record<string, unknown>>;
        }
      } catch { /* start fresh */ }

      const config = this.configs.get(serverName);
      const existing = registry[serverName] ?? {};

      registry[serverName] = {
        ...existing,
        toolCount: toolCount > 0 ? toolCount : (existing.toolCount ?? 0),
        transport: config?.transport ?? existing.transport ?? 'stdio',
        domain: ChildManager.DOMAIN_MAP[serverName.toLowerCase()] ?? existing.domain ?? 'unknown',
        lastSeen: new Date().toISOString(),
        health,
      };

      mkdirSync(dir, { recursive: true });
      writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
    } catch (err) {
      log('warn', 'registry persist failed', {
        server: serverName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
