/**
 * Circuit breaker for child server health tracking.
 *
 * Behavior:
 *   - On failure: increment counter, trip at threshold, reset counter after trip
 *   - On success: reset counter to zero immediately
 *   - After trip: cooldown period before allowing requests again
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private failedAt = 0;
  private tripped = false;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  /** Record a failure. Increments counter. Trips at threshold. Resets counter after trip. */
  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold) {
      this.tripped = true;
      this.failedAt = Date.now();
      this.consecutiveFailures = 0;
    }
  }

  /** Record success. Resets failure counter to zero immediately — no hysteresis. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.tripped) {
      this.tripped = false;
    }
  }

  /** Check if circuit breaker is open (tripped AND within cooldown). */
  isOpen(now?: number): boolean {
    if (!this.tripped) return false;
    const elapsed = (now ?? Date.now()) - this.failedAt;
    return elapsed <= this.cooldownMs;
  }

  /** Full reset — clear all state. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.failedAt = 0;
    this.tripped = false;
  }
}
