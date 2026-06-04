import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LedgerEntry } from './ledger.js';

export interface EvidenceBundleEntry {
  index: number;
  id: string;
  prevHash: string;
  hash: string;
  entry: LedgerEntry;
}

export interface EvidenceBundle {
  schema: 'io.mentu.metamcp.evidence-bundle.v1';
  generatedAt: string;
  sourceLedger: string;
  entryCount: number;
  genesisHash: string;
  headHash: string;
  entries: EvidenceBundleEntry[];
}

const DEFAULT_LEDGER_PATH = join('.metamcp', 'ledger.jsonl');
const DEFAULT_OUTPUT_PATH = join('.metamcp', 'evidence-bundle.json');
const GENESIS_HASH = '0'.repeat(64);

export async function exportEvidenceBundle(
  ledgerPath = DEFAULT_LEDGER_PATH,
  outputPath = DEFAULT_OUTPUT_PATH,
): Promise<EvidenceBundle> {
  const entries = await readLedgerEntries(ledgerPath);
  const bundleEntries: EvidenceBundleEntry[] = [];
  let prevHash = GENESIS_HASH;

  entries.forEach((entry, index) => {
    const id = `ev_${randomBytes(6).toString('hex')}`;
    const hash = hashCanonical({ index, prevHash, entry });
    bundleEntries.push({ index, id, prevHash, hash, entry });
    prevHash = hash;
  });

  const bundle: EvidenceBundle = {
    schema: 'io.mentu.metamcp.evidence-bundle.v1',
    generatedAt: new Date().toISOString(),
    sourceLedger: ledgerPath,
    entryCount: bundleEntries.length,
    genesisHash: GENESIS_HASH,
    headHash: prevHash,
    entries: bundleEntries,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

export function verifyEvidenceBundle(bundle: EvidenceBundle): boolean {
  let prevHash = bundle.genesisHash;
  for (const entry of bundle.entries) {
    if (entry.prevHash !== prevHash) return false;
    const expected = hashCanonical({
      index: entry.index,
      prevHash: entry.prevHash,
      entry: entry.entry,
    });
    if (entry.hash !== expected) return false;
    prevHash = entry.hash;
  }
  return bundle.headHash === prevHash && bundle.entryCount === bundle.entries.length;
}

export async function runEvidenceExportCli(argv: string[]): Promise<void> {
  let ledgerPath = DEFAULT_LEDGER_PATH;
  let outputPath = DEFAULT_OUTPUT_PATH;
  let verifyOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ledger') {
      ledgerPath = argv[++i];
    } else if (arg === '--out') {
      outputPath = argv[++i];
    } else if (arg === '--verify') {
      verifyOnly = true;
    } else if (arg === '--help') {
      process.stderr.write(`Usage: metamcp export-evidence [--ledger .metamcp/ledger.jsonl] [--out .metamcp/evidence-bundle.json] [--verify]\n`);
      return;
    } else {
      throw new Error(`Unknown export-evidence option: ${arg}`);
    }
  }

  if (verifyOnly) {
    const raw = await readFile(outputPath, 'utf-8');
    const bundle = JSON.parse(raw) as EvidenceBundle;
    if (!verifyEvidenceBundle(bundle)) {
      process.stderr.write(`Evidence bundle failed verification: ${outputPath}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Verified ${bundle.entryCount} evidence entries: ${outputPath}\n`);
    return;
  }

  const bundle = await exportEvidenceBundle(ledgerPath, outputPath);
  process.stdout.write(`Exported ${bundle.entryCount} evidence entries to ${outputPath}\n`);
}

async function readLedgerEntries(path: string): Promise<LedgerEntry[]> {
  const raw = await readFile(path, 'utf-8');
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as LedgerEntry;
      } catch {
        throw new Error(`Invalid JSONL ledger entry at line ${index + 1}`);
      }
    });
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
}
