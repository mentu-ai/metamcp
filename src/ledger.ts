/**
 * MetaMCP Ledger - ordered append-only JSONL logging.
 *
 * Every mcp_call and mcp_run invocation is recorded to .metamcp/ledger.jsonl.
 * Writes are serialized and each tool response waits for its append attempt.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './log.js';

export interface LedgerEntry {
  timestamp: string;
  tool: 'mcp_call' | 'mcp_run';
  server: string | null;
  childTool?: string;
  duration_ms: number;
  success: boolean;
  error?: string;
}

const LEDGER_DIR = '.metamcp';
const LEDGER_FILE = join(LEDGER_DIR, 'ledger.jsonl');

let dirEnsured = false;
let writeTail: Promise<void> = Promise.resolve();

async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  try {
    await mkdir(LEDGER_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // directory may already exist - that's fine
    dirEnsured = true;
  }
}

/** Append a ledger entry in call-completion order. Logging failure never replays a tool. */
export function recordLedger(entry: LedgerEntry): Promise<void> {
  const append = writeTail.then(async () => {
    try {
      await ensureDir();
      await appendFile(LEDGER_FILE, JSON.stringify(entry) + '\n');
    } catch (err) {
      log('warn', 'ledger write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  writeTail = append;
  return append;
}
