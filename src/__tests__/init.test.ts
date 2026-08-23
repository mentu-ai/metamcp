import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init.js';

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
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${message}`);
    console.log(`  FAIL: ${name} - ${message}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  console.log('Init Safety Tests\n');
  const root = mkdtempSync(join(tmpdir(), 'metamcp-init-'));
  try {
    await test('init previews existing clients without writing', async () => {
      const home = join(root, 'preview');
      const path = join(home, '.claude.json');
      await import('node:fs/promises').then(fs => fs.mkdir(home, { recursive: true }));
      const original = '{"theme":"dark","mcpServers":{}}\n';
      writeFileSync(path, original);
      const result = await runInit({ yes: false, json: true, homeDir: home });
      assert(result.success, 'preview should succeed');
      assert(result.applied === false, 'preview applied flag');
      assert(result.configuredClients[0]?.status === 'planned', 'planned status');
      assert(readFileSync(path, 'utf-8') === original, 'preview changed config');
      assert(!existsSync(`${path}.bak`), 'preview created backup');
    });

    await test('explicit apply merges atomically and preserves a backup', async () => {
      const home = join(root, 'apply');
      const path = join(home, '.claude.json');
      await import('node:fs/promises').then(fs => fs.mkdir(home, { recursive: true }));
      const original = '{"theme":"dark","mcpServers":{}}\n';
      writeFileSync(path, original);
      const result = await runInit({ yes: true, json: true, homeDir: home });
      assert(result.success && result.applied, 'apply result');
      const updated = JSON.parse(readFileSync(path, 'utf-8')) as {
        theme?: string;
        mcpServers?: { metamcp?: { command?: string } };
      };
      assert(updated.theme === 'dark', 'existing config lost');
      assert(updated.mcpServers?.metamcp?.command === 'node', 'metamcp entry missing');
      assert(readFileSync(`${path}.bak`, 'utf-8') === original, 'backup mismatch');
    });

    await test('invalid JSON is rejected in preview and apply', async () => {
      const home = join(root, 'invalid');
      const path = join(home, '.claude.json');
      await import('node:fs/promises').then(fs => fs.mkdir(home, { recursive: true }));
      writeFileSync(path, '{not json');
      const preview = await runInit({ yes: false, json: true, homeDir: home });
      assert(!preview.success && preview.failedClients.length === 1, 'invalid preview accepted');
      const apply = await runInit({ yes: true, json: true, homeDir: home });
      assert(!apply.success && apply.failedClients.length === 1, 'invalid apply accepted');
      assert(readFileSync(path, 'utf-8') === '{not json', 'invalid config was replaced');
    });

    await test('invalid JSON structure is rejected in preview and apply', async () => {
      const home = join(root, 'invalid-structure');
      const path = join(home, '.claude.json');
      await import('node:fs/promises').then(fs => fs.mkdir(home, { recursive: true }));
      writeFileSync(path, '{"mcpServers":[]}');
      const preview = await runInit({ yes: false, json: true, homeDir: home });
      const apply = await runInit({ yes: true, json: true, homeDir: home });
      assert(!preview.success && !apply.success, 'invalid structure accepted');
      assert(readFileSync(path, 'utf-8') === '{"mcpServers":[]}', 'invalid structure was replaced');
    });

    await test('a named client may be created explicitly', async () => {
      const home = join(root, 'targeted');
      const result = await runInit({ yes: true, json: true, homeDir: home, clients: ['Cursor'] });
      const path = join(home, '.cursor', 'mcp.json');
      assert(result.success, `targeted init failed: ${JSON.stringify(result)}`);
      assert(existsSync(path), 'targeted config was not created');
      assert(result.configuredClients.length === 1, 'unexpected client fanout');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
