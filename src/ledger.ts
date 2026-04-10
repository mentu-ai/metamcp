/**
 * MetaMCP Ledger — async append-only JSONL logging.
 *
 * Every mcp_call and mcp_execute invocation is recorded to .metamcp/ledger.jsonl.
 * Non-blocking fire-and-forget writes — never blocks tool execution.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './log.js';

export interface LedgerEntry {
  timestamp: string;
  tool: 'mcp_call' | 'mcp_execute';
  server: string | null;
  childTool?: string;
  duration_ms: number;
  success: boolean;
  error?: string;
}

const LEDGER_DIR = '.metamcp';
const LEDGER_FILE = join(LEDGER_DIR, 'ledger.jsonl');

let dirEnsured = false;

async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  try {
    await mkdir(LEDGER_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // directory may already exist — that's fine
    dirEnsured = true;
  }
}

/** Append a ledger entry. Non-blocking — errors are logged but never thrown. */
export function recordLedger(entry: LedgerEntry): void {
  // Fire-and-forget: do not await, do not block caller
  void (async () => {
    try {
      await ensureDir();
      await appendFile(LEDGER_FILE, JSON.stringify(entry) + '\n');
    } catch (err) {
      log('warn', 'ledger write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
