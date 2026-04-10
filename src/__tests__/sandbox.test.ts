/**
 * Sandbox Escape Vector Tests.
 *
 * These tests cover the known Node.js vm escape vectors:
 * constructor.constructor, require, process, eval, Function constructor,
 * prototype pollution, SharedArrayBuffer, WebAssembly, infinite loops.
 */

import { execute } from '../sandbox.js';
import { ChildManager } from '../child-manager.js';
import { ToolCatalog } from '../catalog.js';

// Minimal stubs for testing — no real child servers needed
const childManager = new ChildManager();
const catalog = new ToolCatalog();

async function assertThrows(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
    throw new Error(`Expected ${label} to throw, but it did not`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Expected')) {
      throw err;
    }
    // Expected error — pass
  }
}

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      passed++;
      console.log(`  PASS: ${name}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${name}: ${msg}`);
      console.log(`  FAIL: ${name} — ${msg}`);
    }
  }

  console.log('Sandbox Escape Vector Tests\n');

  // 1. Function constructor escape — must throw
  await test('Function constructor escape blocked', async () => {
    await assertThrows(
      () => execute(`return this.constructor.constructor('return process')()`, childManager, catalog),
      'constructor.constructor escape',
    );
  });

  // 2. require — must throw
  await test('require() blocked', async () => {
    await assertThrows(
      () => execute(`return require('fs')`, childManager, catalog),
      'require escape',
    );
  });

  // 3. process access — must throw
  await test('process access blocked', async () => {
    await assertThrows(
      () => execute(`return process.exit(1)`, childManager, catalog),
      'process escape',
    );
  });

  // 4. Infinite loop — must timeout
  await test('Infinite loop times out', async () => {
    await assertThrows(
      () => execute(`while(true){}`, childManager, catalog),
      'infinite loop timeout',
    );
  });

  // 5. Basic computation — must return 2
  await test('Basic computation returns 2', async () => {
    const result = await execute(`return 1 + 1`, childManager, catalog);
    if (result.value !== 2) {
      throw new Error(`Expected 2, got ${result.value}`);
    }
  });

  // 6. Server proxy — errors gracefully when no server available
  await test('Server proxy errors gracefully', async () => {
    await assertThrows(
      () => execute(`return await servers.nonexistent.call("some_tool", {limit:1})`, childManager, catalog),
      'server proxy on unavailable server',
    );
  });

  // 7. Code size limit — must reject
  await test('Code size limit enforced', async () => {
    const bigCode = 'x'.repeat(51 * 1024);
    await assertThrows(
      () => execute(bigCode, childManager, catalog),
      'code size limit',
    );
  });

  // 8. Prototype pollution — must not affect host
  await test('Prototype pollution blocked', async () => {
    // Object.prototype is sealed (not frozen) by lockPrototypes().
    // In strict mode, assigning new properties to a sealed object throws TypeError.
    // Either the sandbox throws, or if it somehow succeeds, verify host is clean.
    try {
      await execute(`Object.prototype.polluted = true`, childManager, catalog);
    } catch {
      // Throwing is acceptable — means the protection worked
    }
    if ('polluted' in {}) {
      throw new Error('Prototype pollution escaped sandbox!');
    }
  });

  // 9. eval() blocked — codeGeneration.strings:false makes eval throw EvalError
  await test('eval() blocked', async () => {
    await assertThrows(
      () => execute(`return eval('1 + 1')`, childManager, catalog),
      'eval escape',
    );
  });

  // 10. Function constructor blocked — same codeGeneration.strings:false
  await test('Function constructor blocked', async () => {
    await assertThrows(
      () => execute(`return new Function('return 1')()`, childManager, catalog),
      'Function constructor escape',
    );
  });

  // 11. SharedArrayBuffer not accessible — deleted from context
  await test('SharedArrayBuffer removed from context', async () => {
    const result = await execute(`return typeof SharedArrayBuffer`, childManager, catalog);
    if (result.value !== 'undefined') {
      throw new Error(`SharedArrayBuffer should not be available, got type: ${result.value}`);
    }
  });

  // 12. WebAssembly not accessible — deleted from context
  await test('WebAssembly removed from context', async () => {
    const result = await execute(`return typeof WebAssembly`, childManager, catalog);
    if (result.value !== 'undefined') {
      throw new Error(`WebAssembly should not be available, got type: ${result.value}`);
    }
  });

  // 13. Console capture works
  await test('Console capture works', async () => {
    const result = await execute(`console.log('hello'); return 42`, childManager, catalog);
    if (result.value !== 42) throw new Error(`Expected 42, got ${result.value}`);
    if (!result.console.includes('hello')) throw new Error(`Console not captured: ${JSON.stringify(result.console)}`);
  });

  // 10. sleep() function works
  await test('sleep() works and is capped', async () => {
    const start = Date.now();
    await execute(`await sleep(100)`, childManager, catalog);
    const elapsed = Date.now() - start;
    if (elapsed < 50) throw new Error(`Sleep too short: ${elapsed}ms`);
  });

  // 11. Async/await works
  await test('Async/await works', async () => {
    const result = await execute(
      `const p = new Promise(resolve => setTimeout(() => resolve(42), 10)); return await p`,
      childManager, catalog,
    );
    if (result.value !== 42) throw new Error(`Expected 42, got ${result.value}`);
  });

  // 16. Output size cap — console output truncated at 10MB
  await test('Console output truncated at 10MB', async () => {
    // Each line is ~1KB, 12000 lines > 10MB
    const result = await execute(
      `for (let i = 0; i < 12000; i++) { console.log('x'.repeat(1000)); }`,
      childManager, catalog,
    );
    const lastLine = result.console[result.console.length - 1];
    if (lastLine !== '[output truncated]') {
      throw new Error(`Expected truncation marker, got: ${lastLine}`);
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exit(1);
  }
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
