import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  exportEvidenceBundle,
  verifyEvidenceBundle,
  type EvidenceBundle,
} from '../evidence-export.js';

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
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  FAIL: ${name} - ${msg}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function runTests(): Promise<void> {
  console.log('Evidence Export Tests\n');

  await test('exports and verifies a hash-linked bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'metamcp-evidence-'));
    try {
      const ledger = join(dir, 'ledger.jsonl');
      const out = join(dir, 'evidence-bundle.json');
      await import('node:fs/promises').then(fs => fs.writeFile(ledger, [
        JSON.stringify({
          timestamp: '2026-06-04T00:00:00.000Z',
          tool: 'mcp_call',
          server: 'airtable',
          childTool: 'list_records',
          duration_ms: 12,
          success: true,
        }),
        JSON.stringify({
          timestamp: '2026-06-04T00:00:01.000Z',
          tool: 'mcp_run',
          server: null,
          duration_ms: 30,
          success: false,
          error: 'denied',
        }),
      ].join('\n')));

      const bundle = await exportEvidenceBundle(ledger, out);
      assert(bundle.entryCount === 2, 'entry count');
      assert(bundle.entries[0].prevHash === bundle.genesisHash, 'first entry starts from genesis');
      assert(bundle.entries[1].prevHash === bundle.entries[0].hash, 'second entry links to first');
      assert(verifyEvidenceBundle(bundle), 'bundle verifies');

      const saved = JSON.parse(await readFile(out, 'utf-8')) as EvidenceBundle;
      assert(verifyEvidenceBundle(saved), 'saved bundle verifies');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await test('detects tampering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'metamcp-evidence-'));
    try {
      const ledger = join(dir, 'ledger.jsonl');
      const out = join(dir, 'evidence-bundle.json');
      await import('node:fs/promises').then(fs => fs.writeFile(ledger, `${JSON.stringify({
        timestamp: '2026-06-04T00:00:00.000Z',
        tool: 'mcp_call',
        server: 'cotizera',
        childTool: 'draft_quote',
        duration_ms: 22,
        success: true,
      })}\n`));
      const bundle = await exportEvidenceBundle(ledger, out);
      bundle.entries[0].entry.success = false;
      assert(!verifyEvidenceBundle(bundle), 'tampered bundle fails');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  if (failed > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
