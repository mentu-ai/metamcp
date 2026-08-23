import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { analyzeConnectionError, isTransientIssue } from '../error-classifier.js';
import { InputRequiredError, ModernRequestError } from '../modern-client.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`  FAIL: ${name} - ${message}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

console.log('Connection Error Classification Tests\n');

test('legacy and modern protocol errors keep a healthy connection reusable', () => {
  const legacy = analyzeConnectionError(new McpError(ErrorCode.MethodNotFound, 'missing tool'));
  const modern = analyzeConnectionError(new ModernRequestError(ErrorCode.InvalidParams, 'bad arguments'));
  const inputRequired = analyzeConnectionError(new InputRequiredError('tools/call', {}));
  assert(legacy.kind === 'protocol' && !isTransientIssue(legacy), 'legacy protocol error is transient');
  assert(modern.kind === 'protocol' && !isTransientIssue(modern), 'modern protocol error is transient');
  assert(inputRequired.kind === 'protocol' && !isTransientIssue(inputRequired), 'input-required result is transient');
});

test('request timeouts and stdio exits retire the connection', () => {
  const timeout = analyzeConnectionError(new McpError(ErrorCode.RequestTimeout, 'Request timed out'));
  const closed = analyzeConnectionError(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'));
  const exited = analyzeConnectionError(new Error('stdio process exited with code 91'));
  assert(timeout.kind === 'offline' && isTransientIssue(timeout), 'request timeout is not transient');
  assert(closed.kind === 'offline' && isTransientIssue(closed), 'closed connection is not transient');
  assert(exited.kind === 'stdio-exit' && isTransientIssue(exited), 'stdio exit is not transient');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
