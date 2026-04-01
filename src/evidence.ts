/**
 * Evidence Mode — structured investigation tracking.
 *
 * Typed records with confidence scoring, gap tracking, and session scoping.
 * Sits on top of ledger.ts (telemetry) — this is structured evidence, not raw logs.
 */

import { randomBytes } from 'node:crypto';


// ─── Gap Tracking ────────────────────────────────────────────────────────────

export interface Gap {
  dimension: string;   // "server_unavailable", "tool_timeout", "low_confidence_match", "partial_output"
  reason: string;
  impact: 'reducing' | 'blocking' | 'cosmetic';
}

// ─── Evidence Records ────────────────────────────────────────────────────────

export interface ToolCallEvidence {
  server: string;
  tool: string;
  input: Record<string, unknown>;
  outputSummary: string;     // compressed result (context isolation — not raw output)
  durationMs: number;
  success: boolean;
  confidence: number;
  gaps: Gap[];
  timestamp: string;
}

// ─── Confidence Calculator ───────────────────────────────────────────────────

export class ConfidenceCalculator {
  /**
   * Compute confidence from evidence source count and gaps.
   * Mirrors the Python reference logic: 0.3 base + 0.1 per additional source,
   * single-source penalty, gap penalties.
   */
  static compute(evidenceSources: number, gaps: Gap[]): number {
    let score = Math.min(1.0, 0.3 + (evidenceSources - 1) * 0.1);
    for (const gap of gaps) {
      if (gap.impact === 'reducing') {
        score -= 0.15;
      } else if (gap.impact === 'blocking') {
        score = Math.min(score, 0.5);
      }
    }
    // Single-source penalty: softer than multiplicative ×0.5.
    // A single-server result IS the complete answer for many tasks.
    if (evidenceSources === 1 && gaps.length === 0) {
      score = Math.max(score, 0.4);  // Floor at moderate confidence
    } else if (evidenceSources === 1) {
      score *= 0.7;  // Softer penalty when gaps exist (was ×0.5)
    }
    return Math.max(0.0, Math.round(score * 100) / 100);
  }

  /**
   * Compute confidence for a tool call based on observable signals.
   */
  static fromToolCall(
    success: boolean,
    durationMs: number,
    hasOutput: boolean,
    outputLength: number,
  ): number {
    const gaps: Gap[] = [];
    let sources = 0;

    if (success) {
      sources += 1;
    } else {
      gaps.push({ dimension: 'tool_error', reason: 'Tool call returned error', impact: 'blocking' });
    }

    if (hasOutput && outputLength > 0) {
      sources += 1;
    } else if (success) {
      gaps.push({ dimension: 'empty_output', reason: 'Tool succeeded but produced no output', impact: 'reducing' });
    }

    if (durationMs > 30_000) {
      gaps.push({ dimension: 'slow_response', reason: `Tool took ${durationMs}ms`, impact: 'reducing' });
    }

    return ConfidenceCalculator.compute(sources, gaps);
  }
}

// ─── Session Summary ─────────────────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  goal: string;
  callCount: number;
  successCount: number;
  failureCount: number;
  gapCount: number;
  overallConfidence: number;
  serversUsed: string[];
  methodsUsed: string[];
  durationMs: number;
}

// ─── Investigation Session ───────────────────────────────────────────────────

export class InvestigationSession {
  readonly id: string;
  readonly goal: string;
  readonly started: Date;
  private _calls: ToolCallEvidence[] = [];
  private _serversUsed: Set<string> = new Set();
  private _methodsUsed: Set<string> = new Set();

  constructor(goal: string, id?: string) {
    this.id = id ?? `ev_${randomBytes(6).toString('hex')}`;
    this.goal = goal;
    this.started = new Date();
  }

  get calls(): readonly ToolCallEvidence[] {
    return this._calls;
  }

  get serversUsed(): string[] {
    return [...this._serversUsed];
  }

  get methodsUsed(): string[] {
    return [...this._methodsUsed];
  }

  /**
   * Record a tool call with auto-computed confidence.
   */
  recordCall(
    server: string,
    tool: string,
    input: Record<string, unknown>,
    outputSummary: string,
    durationMs: number,
    success: boolean,
    method: string,
    gaps?: Gap[],
  ): ToolCallEvidence {
    const autoGaps = gaps ?? [];
    const confidence = ConfidenceCalculator.fromToolCall(
      success,
      durationMs,
      outputSummary.length > 0,
      outputSummary.length,
    );

    // Merge auto gaps from confidence calc with any additional gaps
    const finalGaps = [...autoGaps];
    if (!success && !finalGaps.some(g => g.dimension === 'tool_error')) {
      finalGaps.push({ dimension: 'tool_error', reason: 'Tool call returned error', impact: 'blocking' });
    }

    const evidence: ToolCallEvidence = {
      server,
      tool,
      input,
      outputSummary,
      durationMs,
      success,
      confidence,
      gaps: finalGaps,
      timestamp: new Date().toISOString(),
    };

    this._calls.push(evidence);
    this._serversUsed.add(server);
    this._methodsUsed.add(method);
    return evidence;
  }

  /**
   * Record that a meta-method was used (mcp_discover, mcp_provision, mcp_execute).
   */
  recordMethod(method: string): void {
    this._methodsUsed.add(method);
  }

  /**
   * Produce a summary of this investigation session.
   */
  summary(): SessionSummary {
    const successes = this._calls.filter(c => c.success);
    const failures = this._calls.filter(c => !c.success);
    const allGaps: Gap[] = [];
    const confidences: number[] = [];

    for (const call of this._calls) {
      allGaps.push(...call.gaps);
      confidences.push(call.confidence);
    }

    const avgConf = confidences.length > 0
      ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
      : 0;

    return {
      id: this.id,
      goal: this.goal,
      callCount: this._calls.length,
      successCount: successes.length,
      failureCount: failures.length,
      gapCount: allGaps.length,
      overallConfidence: avgConf,
      serversUsed: this.serversUsed,
      methodsUsed: this.methodsUsed,
      durationMs: Date.now() - this.started.getTime(),
    };
  }

  /**
   * Extract labeled quality records from this session.
   * Tool calls that succeeded and produced output → "high"
   * Tool calls that succeeded but produced empty output → "medium"
   * Tool calls that failed → "low"
   */
  toTrainingRecords(): Array<{
    server: string;
    tool: string;
    label: 'high' | 'medium' | 'low';
    investigation: string;
    confidence: number;
  }> {
    return this._calls.map(call => {
      let label: 'high' | 'medium' | 'low';
      if (call.success && call.outputSummary.length > 0) {
        label = 'high';
      } else if (call.success) {
        label = 'medium';
      } else {
        label = 'low';
      }
      return {
        server: call.server,
        tool: call.tool,
        label,
        investigation: this.id,
        confidence: call.confidence,
      };
    });
  }
}

// ─── VM Execution Evidence ──────────────────────────────────────────────────

export interface VMExecutionEvidence {
  jobId: string;
  engine: string;
  flowCount: number;
  exitCode: number;
  durationMs: number;
  specPath?: string;
}

// ─── Session Manager ─────────────────────────────────────────────────────────

export class EvidenceSessionManager {
  private _active: InvestigationSession | null = null;
  private _completed: SessionSummary[] = [];
  private readonly _maxCompleted: number;
  private _closeCount = 0;
  private _onClose: ((count: number) => void) | null = null;
  private _vmExecutions: VMExecutionEvidence[] = [];

  constructor(maxCompleted = 50) {
    this._maxCompleted = maxCompleted;
  }

  /** Register a callback invoked after every session close with the running close count. */
  onClose(cb: (count: number) => void): void {
    this._onClose = cb;
  }

  get closeCount(): number {
    return this._closeCount;
  }

  get active(): InvestigationSession | null {
    return this._active;
  }

  get completedSessions(): readonly SessionSummary[] {
    return this._completed;
  }

  /**
   * Start a new investigation session. Closes any active session first.
   */
  start(goal: string, id?: string): InvestigationSession {
    if (this._active) {
      this.close();
    }
    this._active = new InvestigationSession(goal, id);
    return this._active;
  }

  /**
   * Close the active session and archive its summary.
   */
  close(): SessionSummary | null {
    if (!this._active) return null;
    const summary = this._active.summary();
    this._completed.push(summary);
    if (this._completed.length > this._maxCompleted) {
      this._completed.shift();
    }
    this._active = null;

    // Notify close listener
    this._closeCount++;
    if (this._onClose) {
      try { this._onClose(this._closeCount); } catch { /* non-fatal */ }
    }

    return summary;
  }

  /**
   * Record a VM execution outcome.
   */
  recordVMExecution(evidence: VMExecutionEvidence): void {
    this._vmExecutions.push(evidence);

    if (evidence.exitCode !== 0 && this._active) {
      this._active.recordCall(
        'vm-runtime', evidence.engine,
        { jobId: evidence.jobId },
        `VM engine exited with code ${evidence.exitCode}`,
        evidence.durationMs,
        false,
        'vm_execute_engine',
        [{ dimension: 'vm_execution', reason: `Engine ${evidence.engine} exited with code ${evidence.exitCode}`, impact: 'reducing' }],
      );
    }
  }

  /**
   * Record a tool call on the active session.
   * If no session is active, creates a default one.
   */
  recordCall(
    server: string,
    tool: string,
    input: Record<string, unknown>,
    outputSummary: string,
    durationMs: number,
    success: boolean,
    method: string,
    gaps?: Gap[],
  ): ToolCallEvidence {
    if (!this._active) {
      this.start('auto');
    }
    return this._active!.recordCall(
      server, tool, input, outputSummary, durationMs, success, method, gaps,
    );
  }
}
