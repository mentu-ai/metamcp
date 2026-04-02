/**
 * ConnectionState — validated finite state machine for child server connections.
 */
export enum ConnectionState {
  IDLE = 'idle',           // Ready for use
  CONNECTING = 'connecting', // Handshake in progress
  ACTIVE = 'active',       // Processing request
  FAILED = 'failed',       // Circuit breaker tripped
  CLOSED = 'closed'        // Deallocated
}

/**
 * Validated transition table. canTransition() enforces state discipline.
 */
const VALID_TRANSITIONS: Record<ConnectionState, ConnectionState[]> = {
  [ConnectionState.IDLE]: [ConnectionState.CONNECTING, ConnectionState.ACTIVE, ConnectionState.CLOSED],
  [ConnectionState.CONNECTING]: [ConnectionState.ACTIVE, ConnectionState.FAILED, ConnectionState.CLOSED],
  [ConnectionState.ACTIVE]: [ConnectionState.IDLE, ConnectionState.FAILED, ConnectionState.CLOSED],
  [ConnectionState.FAILED]: [ConnectionState.CONNECTING, ConnectionState.CLOSED],
  [ConnectionState.CLOSED]: []  // terminal — no transitions out
};

export function canTransition(from: ConnectionState, to: ConnectionState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export type ServiceCriticality = 'vital' | 'optional';

export type TransportType = 'stdio' | 'http' | 'sse';

export type ServerLifecycle =
  | { mode: 'keep-alive'; idleTimeoutMs?: number }
  | { mode: 'ephemeral' };

export interface ServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: TransportType;
  headers?: Record<string, string>;
  oauth?: boolean;
  timeoutMs?: number;
  lifecycle?: ServerLifecycle;
  criticality: ServiceCriticality;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  server: string;
}

export interface ToolMatch {
  tool: ToolDefinition;
  score: number;
  confidence: number;
}

export interface RegistryEntry {
  name: string;
  description: string;
  command: string;
  args?: string[];
  namespace?: string;
}

export interface TrustDecision {
  namespace: string;
  trusted: boolean;
  confidence: number;
  decision: 'allow' | 'deny';
}

/**
 * Pool sizing config.
 *
 * Upper bound: poolSize + resPoolSize — evict idle children when exceeded.
 * Lower bound: minPoolSize — caller launches new children when below.
 * Reserve pool: activates only when resPoolTimeout > 0, resPoolSize > 0,
 *   AND the oldest waiter has waited >= resPoolTimeout.
 * Eviction: LIFO insert at HEAD + evict from TAIL = oldest idle evicted first.
 */
export interface PoolConfig {
  poolSize: number;          // Max concurrent children (default 20)
  resPoolSize: number;       // Reserve above poolSize (default 0)
  minPoolSize: number;       // Minimum to keep alive (default 0)
  resPoolTimeout: number;    // ms before reserve activates (default 5000)
  idleTimeoutMs: number;     // Idle connection timeout in ms (default 300000)
  failureThreshold: number;  // Circuit breaker trips after N failures (default 5)
  cooldownMs: number;        // Circuit breaker cooldown in ms (default 30000)
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  poolSize: 20,
  resPoolSize: 0,
  minPoolSize: 0,
  resPoolTimeout: 5000,
  idleTimeoutMs: 300_000,
  failureThreshold: 5,
  cooldownMs: 30_000,
};

export interface ChildState {
  name: string;
  state: ConnectionState;
  pid?: number;
  toolCount: number;
  criticality: ServiceCriticality;
  restartCount: number;
}
