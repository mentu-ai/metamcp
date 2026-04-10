import { EventEmitter } from 'node:events';

export type ConnectionFSMState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ConnectionFSMOptions {
  name: string;                    // server name (for logging/CIR)
  maxReconnectAttempts?: number;   // default: 10
  initialDelay?: number;           // default: 1000ms
  connectionTimeout?: number;      // default: 5000ms
  maxDelay?: number;               // default: 30000ms (cap backoff)
}

export class MCPConnectionFSM extends EventEmitter {
  private state: ConnectionFSMState = 'disconnected';
  private attempts = 0;
  private delay: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly name: string;
  private readonly maxAttempts: number;
  private readonly initialDelay: number;
  private readonly connectionTimeout: number;
  private readonly maxDelay: number;
  private connectFn: (() => Promise<void>) | null = null;

  constructor(options: ConnectionFSMOptions) {
    super();
    this.name = options.name;
    this.maxAttempts = options.maxReconnectAttempts ?? 10;
    this.initialDelay = options.initialDelay ?? 1000;
    this.delay = this.initialDelay;
    this.connectionTimeout = options.connectionTimeout ?? 5000;
    this.maxDelay = options.maxDelay ?? 30000;
  }

  getState(): ConnectionFSMState { return this.state; }
  getName(): string { return this.name; }
  getAttempts(): number { return this.attempts; }

  setConnectFn(fn: () => Promise<void>): void {
    this.connectFn = fn;
  }

  async connect(): Promise<void> {
    if (!this.connectFn) throw new Error(`No connect function set for ${this.name}`);
    if (this.state === 'connected') return;

    this.transition('connecting');
    try {
      await Promise.race([
        this.connectFn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), this.connectionTimeout)
        ),
      ]);
      this.transition('connected');
      this.attempts = 0;
      this.delay = this.initialDelay;
    } catch (err) {
      this.emit('error', { server: this.name, error: err, attempt: this.attempts });
      this.scheduleReconnect();
    }
  }

  /**
   * Externally notify that connection was established by initial connect logic.
   * Cancels any pending reconnection timer and resets backoff state.
   */
  notifyConnected(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.state === 'connected') return;
    this.transition('connected');
    this.attempts = 0;
    this.delay = this.initialDelay;
  }

  disconnect(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.transition('disconnected');
    this.attempts = 0;
    this.delay = this.initialDelay;
  }

  onDisconnect(): void {
    // Called when an established connection drops
    if (this.state === 'connected') {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.attempts >= this.maxAttempts) {
      this.transition('disconnected');
      this.emit('exhausted', {
        server: this.name,
        attempts: this.attempts,
      });
      return;
    }

    this.transition('reconnecting');
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, this.delay);

    this.emit('reconnecting', {
      server: this.name,
      attempt: this.attempts + 1,
      delay: this.delay,
    });

    // Exponential backoff capped at maxDelay
    this.delay = Math.min(this.delay * 2, this.maxDelay);
    this.attempts++;
  }

  private transition(newState: ConnectionFSMState): void {
    const oldState = this.state;
    if (oldState === newState) return;
    this.state = newState;
    this.emit('stateChange', {
      server: this.name,
      from: oldState,
      to: newState,
      timestamp: Date.now(),
    });
  }

  toJSON() {
    return {
      name: this.name,
      state: this.state,
      attempts: this.attempts,
      maxAttempts: this.maxAttempts,
    };
  }
}
