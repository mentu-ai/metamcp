import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GALLERY, runGalleryAdd } from '../gallery.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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
  console.log('Gallery Contract Tests\n');

await test('gallery metadata is complete and names are unique', () => {
  assert(GALLERY.length > 0, 'gallery is empty');
  const names = new Set<string>();
  for (const entry of GALLERY) {
    assert(entry.name.trim().length > 0, 'entry has no name');
    assert(!names.has(entry.name), `duplicate entry: ${entry.name}`);
    names.add(entry.name);
    assert(entry.description.trim().length > 0, `${entry.name}: missing description`);
    assert(entry.category.trim().length > 0, `${entry.name}: missing category`);
    assert(entry.language.trim().length > 0, `${entry.name}: missing language`);
    assert(entry.repository.startsWith('https://'), `${entry.name}: repository must use HTTPS`);
  }
});

await test('provisionable entries have a complete launcher', () => {
  for (const entry of GALLERY) {
    if (entry.command === undefined) {
      assert(entry.args === undefined, `${entry.name}: args provided without a command`);
      continue;
    }
    assert(entry.command.trim().length > 0, `${entry.name}: empty command`);
    assert(Array.isArray(entry.args) && entry.args.length > 0, `${entry.name}: command has no args`);
    assert(entry.args.every(arg => arg.trim().length > 0), `${entry.name}: launcher has an empty arg`);
  }
});

await test('Fetch uses the published Python launcher', () => {
  const fetch = GALLERY.find(entry => entry.name === 'mcp-server-fetch');
  assert(fetch !== undefined, 'mcp-server-fetch is missing');
  assert(fetch.command === 'uvx', 'Fetch must launch through uvx');
  assert(fetch.args?.length === 1 && fetch.args[0] === 'mcp-server-fetch', 'Fetch package is incorrect');
});

await test('gallery writes atomically and rejects unsafe inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'metamcp-gallery-'));
  try {
    const path = join(root, 'mcp.json');
    const original = '{"theme":"dark","mcpServers":{}}\n';
    writeFileSync(path, original);
    const added = await runGalleryAdd(['mcp-server-fetch', '--config', path, '--json']);
    assert(added, 'Fetch was not added');
    const config = JSON.parse(readFileSync(path, 'utf-8')) as {
      theme?: string;
      mcpServers?: { fetch?: { command?: string; args?: string[] } };
    };
    assert(config.theme === 'dark', 'existing config was lost');
    assert(config.mcpServers?.fetch?.command === 'uvx', 'Fetch launcher missing');
    assert(readFileSync(`${path}.bak`, 'utf-8') === original, 'backup mismatch');

    writeFileSync(path, '{invalid');
    let rejected = false;
    try {
      await runGalleryAdd(['mcp-server-fetch', '--config', path, '--json']);
    } catch {
      rejected = true;
    }
    assert(rejected && readFileSync(path, 'utf-8') === '{invalid', 'invalid JSON was replaced');

    const metadataOnlyPath = join(root, 'metadata-only.json');
    const provisioned = await runGalleryAdd(['winx-code-agent', '--config', metadataOnlyPath, '--json']);
    assert(!provisioned && !existsSync(metadataOnlyPath), 'metadata-only entry created an invalid config');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
