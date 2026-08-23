import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { isValidServerName, type ChildCallOptions } from './types.js';

const METHOD_API_VERSION = 'metamcp.io/v1alpha1';
const MAX_METHOD_STEPS = 64;
const MAX_METHOD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_METHOD_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const STEP_PATTERN = /^[a-z][a-z0-9_-]*$/;
const FORBIDDEN_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

export type MethodEffects = 'read' | 'write' | 'mixed';
export type MethodOnError = 'fail' | 'gap';

export interface MethodRetry {
  maxAttempts: number;
  backoffMs?: number;
}

export interface MethodPoll {
  path: string;
  equals: unknown;
  maxAttempts: number;
  intervalMs?: number;
}

export interface MethodStep {
  id: string;
  server: string;
  tool: string;
  args?: unknown;
  dependsOn?: string[];
  timeoutMs?: number;
  idempotency?: 'safe' | 'unsafe';
  retry?: MethodRetry;
  poll?: MethodPoll;
  onError?: MethodOnError;
}

export interface MethodDefinition {
  apiVersion: typeof METHOD_API_VERSION;
  kind: 'Method';
  metadata: {
    name: string;
    version: string;
    description?: string;
  };
  spec: {
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    effects: MethodEffects;
    timeoutMs?: number;
    maxOutputBytes?: number;
    steps: MethodStep[];
    output?: unknown;
  };
}

export interface MethodSummary {
  name: string;
  version: string;
  description?: string;
  effects: MethodEffects;
  stepCount: number;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface MethodGap {
  code: 'step_failed';
  step: string;
  server: string;
  tool: string;
  message: string;
}

export interface MethodTraceEntry {
  step: string;
  server: string;
  tool: string;
  status: 'completed' | 'gap';
  attempts: number;
  durationMs: number;
}

export interface MethodRunResult {
  method: string;
  version: string;
  status: 'completed' | 'completed_with_gaps';
  output: unknown;
  gaps: MethodGap[];
  trace: MethodTraceEntry[];
}

export type MethodCaller = (
  server: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  options: ChildCallOptions,
) => Promise<unknown>;

interface CompiledMethod {
  definition: MethodDefinition;
  validateInput: ValidateFunction;
  validateOutput?: ValidateFunction;
}

interface TemplateContext {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
}

export class MethodRegistry {
  private readonly methods = new Map<string, CompiledMethod>();
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly validateManifest: ValidateFunction;

  constructor(private readonly directory?: string) {
    const schemaPath = fileURLToPath(new URL('../schemas/method-v1alpha1.schema.json', import.meta.url));
    let schema: object;
    try {
      schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    } catch (err) {
      throw new Error(`Unable to load Method manifest schema ${schemaPath}: ${errorMessage(err)}`);
    }
    this.validateManifest = this.ajv.compile(schema);
  }

  reload(): number {
    const next = new Map<string, CompiledMethod>();
    if (!this.directory) {
      this.methods.clear();
      return 0;
    }

    const directory = resolve(this.directory);
    if (!existsSync(directory)) {
      this.methods.clear();
      return 0;
    }

    const files = readdirSync(directory).filter(file => file.endsWith('.json')).sort();
    for (const file of files) {
      const path = join(directory, file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf-8'));
      } catch (err) {
        throw new Error(`Invalid method file ${path}: ${errorMessage(err)}`);
      }
      const definition = validateMethodDefinition(parsed, path, this.validateManifest);
      if (next.has(definition.metadata.name)) {
        throw new Error(`Duplicate method name ${definition.metadata.name}`);
      }
      const validateInput = this.ajv.compile(definition.spec.inputSchema);
      const validateOutput = definition.spec.outputSchema
        ? this.ajv.compile(definition.spec.outputSchema)
        : undefined;
      next.set(definition.metadata.name, { definition, validateInput, validateOutput });
    }

    this.methods.clear();
    for (const [name, method] of next) this.methods.set(name, method);
    return this.methods.size;
  }

  get(name: string): CompiledMethod | undefined {
    return this.methods.get(name);
  }

  list(): MethodSummary[] {
    return Array.from(this.methods.values(), ({ definition }) => summarize(definition))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  search(query: string): MethodSummary[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.list()
      .map(method => {
        const haystack = `${method.name} ${method.description ?? ''}`.toLowerCase();
        return { method, score: words.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0) };
      })
      .filter(match => match.score > 0)
      .sort((a, b) => b.score - a.score || a.method.name.localeCompare(b.method.name))
      .map(match => match.method);
  }
}

export class MethodRunner {
  constructor(
    private readonly registry: MethodRegistry,
    private readonly call: MethodCaller,
    private readonly allowWrites = false,
  ) {}

  async run(name: string, input: Record<string, unknown>): Promise<MethodRunResult> {
    const compiled = this.registry.get(name);
    if (!compiled) throw new Error(`Unknown method: ${name}`);
    const { definition } = compiled;
    if (definition.spec.effects !== 'read' && !this.allowWrites) {
      throw new Error(`Method ${name} declares ${definition.spec.effects} effects; start MetaMCP with --allow-writes to enable it`);
    }
    if (!compiled.validateInput(input)) {
      throw new Error(`Invalid input for method ${name}: ${formatAjvErrors(compiled.validateInput.errors)}`);
    }

    const timeoutMs = definition.spec.timeoutMs ?? DEFAULT_METHOD_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const context: TemplateContext = { input, steps: {} };
    const gaps: MethodGap[] = [];
    const trace: MethodTraceEntry[] = [];

    for (const step of definition.spec.steps) {
      const startedAt = Date.now();
      const remaining = deadline - startedAt;
      if (remaining <= 0) throw new Error(`Method ${name} exceeded its ${timeoutMs}ms deadline`);
      const argsValue = resolveTemplate(step.args ?? {}, context);
      if (!isRecord(argsValue)) throw new Error(`Method ${name} step ${step.id} args must resolve to an object`);

      const transportAttempts = step.retry?.maxAttempts ?? 1;
      const pollAttempts = step.poll?.maxAttempts ?? 1;
      let attempts = 0;
      let lastError: unknown;
      let completed = false;
      for (let pollAttempt = 1; pollAttempt <= pollAttempts && !completed; pollAttempt++) {
        for (let transportAttempt = 1; transportAttempt <= transportAttempts; transportAttempt++) {
          attempts++;
          try {
            const stepRemaining = deadline - Date.now();
            if (stepRemaining <= 0) throw new Error(`Method ${name} exceeded its ${timeoutMs}ms deadline`);
            const result = await this.call(step.server, step.tool, argsValue, {
              timeoutMs: Math.min(step.timeoutMs ?? stepRemaining, stepRemaining),
            });
            if (isRecord(result) && result.isError === true) {
              throw new ChildToolResultError();
            }
            const normalized = normalizeToolResult(result);
            if (step.poll && !pollSatisfied(normalized, step.poll)) {
              lastError = new PollConditionError();
              break;
            }
            context.steps[step.id] = normalized;
            completed = true;
            lastError = undefined;
            break;
          } catch (err) {
            lastError = err;
            if (transportAttempt < transportAttempts) {
              await delayWithinDeadline(step.retry?.backoffMs ?? 0, deadline, name, timeoutMs);
            }
          }
        }
        if (!completed && lastError instanceof PollConditionError && pollAttempt < pollAttempts) {
          await delayWithinDeadline(step.poll?.intervalMs ?? 1000, deadline, name, timeoutMs);
        } else if (!completed) {
          break;
        }
      }

      if (completed) {
        trace.push({
          step: step.id,
          server: step.server,
          tool: step.tool,
          status: 'completed',
          attempts,
          durationMs: Date.now() - startedAt,
        });
      }

      if (lastError !== undefined) {
        if ((step.onError ?? 'fail') === 'fail') {
          throw new Error(`Method ${name} failed at step ${step.id}: ${safeStepError(lastError)}`);
        }
        const gap: MethodGap = {
          code: 'step_failed',
          step: step.id,
          server: step.server,
          tool: step.tool,
          message: safeStepError(lastError),
        };
        gaps.push(gap);
        context.steps[step.id] = { isError: true, gap };
        trace.push({
          step: step.id,
          server: step.server,
          tool: step.tool,
          status: 'gap',
          attempts,
          durationMs: Date.now() - startedAt,
        });
      }
    }

    const lastStep = definition.spec.steps[definition.spec.steps.length - 1];
    const output = definition.spec.output === undefined
      ? context.steps[lastStep.id]
      : resolveTemplate(definition.spec.output, context);
    if (compiled.validateOutput && !compiled.validateOutput(output)) {
      throw new Error(`Invalid output from method ${name}: ${formatAjvErrors(compiled.validateOutput.errors)}`);
    }
    const maxOutputBytes = definition.spec.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    const outputBytes = Buffer.byteLength(JSON.stringify(output) ?? '', 'utf-8');
    if (outputBytes > maxOutputBytes) {
      throw new Error(`Method ${name} output exceeds its ${maxOutputBytes}-byte limit`);
    }

    return {
      method: name,
      version: definition.metadata.version,
      status: gaps.length > 0 ? 'completed_with_gaps' : 'completed',
      output,
      gaps,
      trace,
    };
  }
}

function validateMethodDefinition(
  value: unknown,
  path: string,
  validateManifest: ValidateFunction,
): MethodDefinition {
  if (!isRecord(value) || value.apiVersion !== METHOD_API_VERSION || value.kind !== 'Method') {
    throw new Error(`Invalid method file ${path}: expected apiVersion ${METHOD_API_VERSION} and kind Method`);
  }
  if (!isRecord(value.metadata) || typeof value.metadata.name !== 'string' || !NAME_PATTERN.test(value.metadata.name)) {
    throw new Error(`Invalid method file ${path}: metadata.name is invalid`);
  }
  if (typeof value.metadata.version !== 'string' || !value.metadata.version.trim()) {
    throw new Error(`Invalid method file ${path}: metadata.version is required`);
  }
  if (value.metadata.description !== undefined && typeof value.metadata.description !== 'string') {
    throw new Error(`Invalid method file ${path}: metadata.description must be a string`);
  }
  if (!isRecord(value.spec) || !isRecord(value.spec.inputSchema)) {
    throw new Error(`Invalid method file ${path}: spec.inputSchema is required`);
  }
  if (value.spec.outputSchema !== undefined && !isRecord(value.spec.outputSchema)) {
    throw new Error(`Invalid method file ${path}: spec.outputSchema must be an object`);
  }
  if (value.spec.effects !== 'read' && value.spec.effects !== 'write' && value.spec.effects !== 'mixed') {
    throw new Error(`Invalid method file ${path}: spec.effects must be read, write, or mixed`);
  }
  if (!Array.isArray(value.spec.steps) || value.spec.steps.length === 0 || value.spec.steps.length > MAX_METHOD_STEPS) {
    throw new Error(`Invalid method file ${path}: spec.steps must contain 1-${MAX_METHOD_STEPS} steps`);
  }
  if (value.spec.timeoutMs !== undefined && !boundedInteger(value.spec.timeoutMs, 1, MAX_METHOD_TIMEOUT_MS)) {
    throw new Error(`Invalid method file ${path}: spec.timeoutMs must be 1-${MAX_METHOD_TIMEOUT_MS}`);
  }
  if (value.spec.maxOutputBytes !== undefined && !boundedInteger(value.spec.maxOutputBytes, 1, MAX_OUTPUT_BYTES)) {
    throw new Error(`Invalid method file ${path}: spec.maxOutputBytes must be 1-${MAX_OUTPUT_BYTES}`);
  }

  const seen = new Set<string>();
  for (const rawStep of value.spec.steps) {
    if (!isRecord(rawStep) || typeof rawStep.id !== 'string' || !STEP_PATTERN.test(rawStep.id)) {
      throw new Error(`Invalid method file ${path}: every step needs a valid id`);
    }
    if (seen.has(rawStep.id)) throw new Error(`Invalid method file ${path}: duplicate step ${rawStep.id}`);
    if (typeof rawStep.server !== 'string' || !isValidServerName(rawStep.server)
      || typeof rawStep.tool !== 'string' || !rawStep.tool || rawStep.tool.length > 256 || /[\u0000-\u001f\u007f]/.test(rawStep.tool)) {
      throw new Error(`Invalid method file ${path}: step ${rawStep.id} needs server and tool`);
    }
    if (rawStep.onError !== undefined && rawStep.onError !== 'fail' && rawStep.onError !== 'gap') {
      throw new Error(`Invalid method file ${path}: step ${rawStep.id} onError must be fail or gap`);
    }
    if (rawStep.dependsOn !== undefined) {
      if (!Array.isArray(rawStep.dependsOn) || rawStep.dependsOn.some(dep => typeof dep !== 'string' || !seen.has(dep))) {
        throw new Error(`Invalid method file ${path}: step ${rawStep.id} dependencies must reference earlier steps`);
      }
    }
    if (rawStep.timeoutMs !== undefined && !boundedInteger(rawStep.timeoutMs, 1, MAX_METHOD_TIMEOUT_MS)) {
      throw new Error(`Invalid method file ${path}: step ${rawStep.id} timeoutMs is invalid`);
    }
    if (rawStep.retry !== undefined) {
      if (!isRecord(rawStep.retry) || !boundedInteger(rawStep.retry.maxAttempts, 2, 5)) {
        throw new Error(`Invalid method file ${path}: step ${rawStep.id} retry.maxAttempts must be 2-5`);
      }
      if (rawStep.idempotency !== 'safe') {
        throw new Error(`Invalid method file ${path}: step ${rawStep.id} retries require idempotency safe`);
      }
      if (rawStep.retry.backoffMs !== undefined && !boundedInteger(rawStep.retry.backoffMs, 0, 30_000)) {
        throw new Error(`Invalid method file ${path}: step ${rawStep.id} retry.backoffMs is invalid`);
      }
    }
    if (rawStep.poll !== undefined) {
      if (!isRecord(rawStep.poll)
        || typeof rawStep.poll.path !== 'string'
        || !rawStep.poll.path
        || !Object.prototype.hasOwnProperty.call(rawStep.poll, 'equals')
        || !boundedInteger(rawStep.poll.maxAttempts, 1, 100)) {
        throw new Error(`Invalid method file ${path}: step ${rawStep.id} poll requires path, equals, and maxAttempts 1-100`);
      }
      if (rawStep.idempotency !== 'safe') {
        throw new Error(`Invalid method file ${path}: step ${rawStep.id} polling requires idempotency safe`);
      }
      if (rawStep.poll.intervalMs !== undefined && !boundedInteger(rawStep.poll.intervalMs, 0, 30_000)) {
        throw new Error(`Invalid method file ${path}: step ${rawStep.id} poll.intervalMs is invalid`);
      }
      validatePathParts(rawStep.poll.path, `poll path in step ${rawStep.id}`);
    }
    seen.add(rawStep.id);
  }
  if (!validateManifest(value)) {
    throw new Error(`Invalid method file ${path}: ${formatAjvErrors(validateManifest.errors)}`);
  }
  return value as unknown as MethodDefinition;
}

function resolveTemplate(value: unknown, context: TemplateContext): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\$\{([^}]+)\}$/);
    if (exact) return resolveReference(exact[1], context);
    return value.replace(/\$\{([^}]+)\}/g, (_match, reference: string) => {
      const resolved = resolveReference(reference, context);
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map(item => resolveTemplate(item, context));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveTemplate(child, context)]));
  }
  return value;
}

function resolveReference(reference: string, context: TemplateContext): unknown {
  const parts = reference.split('.');
  if (parts.length < 2 || (parts[0] !== 'input' && parts[0] !== 'steps')) {
    throw new Error(`Invalid method reference: ${reference}`);
  }
  if (parts.some(part => !part || FORBIDDEN_PATH_PARTS.has(part))) {
    throw new Error(`Unsafe method reference: ${reference}`);
  }
  let current: unknown = parts[0] === 'input' ? context.input : context.steps;
  for (const part of parts.slice(1)) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else {
      throw new Error(`Unresolved method reference: ${reference}`);
    }
  }
  return current;
}

function normalizeToolResult(result: unknown): unknown {
  if (!isRecord(result)) return { value: result };
  return {
    content: result.content,
    structuredContent: result.structuredContent,
    isError: result.isError === true,
  };
}

function pollSatisfied(result: unknown, poll: MethodPoll): boolean {
  let current = result;
  for (const part of poll.path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else {
      return false;
    }
  }
  return JSON.stringify(current) === JSON.stringify(poll.equals);
}

function validatePathParts(path: string, label: string): void {
  const parts = path.split('.');
  if (parts.some(part => !part || FORBIDDEN_PATH_PARTS.has(part))) {
    throw new Error(`Unsafe ${label}: ${path}`);
  }
}

function summarize(definition: MethodDefinition): MethodSummary {
  return {
    name: definition.metadata.name,
    version: definition.metadata.version,
    description: definition.metadata.description,
    effects: definition.spec.effects,
    stepCount: definition.spec.steps.length,
    inputSchema: definition.spec.inputSchema,
    outputSchema: definition.spec.outputSchema,
  };
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class ChildToolResultError extends Error {
  constructor() {
    super('Child tool returned an error result');
  }
}

class PollConditionError extends Error {
  constructor() {
    super('Poll condition was not satisfied within the configured attempts');
  }
}

function safeStepError(err: unknown): string {
  if (err instanceof ChildToolResultError) return err.message;
  if (err instanceof PollConditionError) return err.message;
  if (err instanceof Error && /deadline|timed? ?out/i.test(err.message)) return 'Step deadline exceeded';
  return 'Child tool call failed';
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function delayWithinDeadline(ms: number, deadline: number, method: string, timeoutMs: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`Method ${method} exceeded its ${timeoutMs}ms deadline`);
  if (ms >= remaining) {
    await delay(remaining);
    throw new Error(`Method ${method} exceeded its ${timeoutMs}ms deadline`);
  }
  await delay(ms);
}
