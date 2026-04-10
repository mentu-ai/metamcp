import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * SQLite-backed vector storage for tool embeddings.
 *
 * Stores Float32 embedding blobs alongside tool metadata.
 * Brute-force cosine similarity search (adequate at MetaMCP scale).
 * Schema versioning via version table with auto-migrate.
 */

const CURRENT_SCHEMA_VERSION = 1;

export interface VectorSearchResult {
  server: string;
  toolName: string;
  description: string;
  similarity: number;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class VectorStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(os.homedir(), '.metamcp', 'catalog.db');
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      );
    `);

    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    const currentVersion = row?.version ?? 0;

    if (currentVersion < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tool_embeddings (
          server TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          description TEXT NOT NULL,
          embedding BLOB NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (server, tool_name)
        );

        CREATE INDEX IF NOT EXISTS idx_tool_embeddings_server
          ON tool_embeddings(server);
      `);

      if (currentVersion === 0 && !row) {
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
      } else {
        this.db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION);
      }
    }
  }

  upsert(server: string, toolName: string, description: string, embedding: Float32Array): void {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.prepare(`
      INSERT INTO tool_embeddings (server, tool_name, description, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server, tool_name) DO UPDATE SET
        description = excluded.description,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at
    `).run(server, toolName, description, buf, Date.now());
  }

  search(queryEmbedding: Float32Array, limit: number = 20): VectorSearchResult[] {
    const rows = this.db.prepare(
      'SELECT server, tool_name, description, embedding FROM tool_embeddings'
    ).all() as Array<{ server: string; tool_name: string; description: string; embedding: Buffer }>;

    const results: VectorSearchResult[] = [];
    for (const row of rows) {
      const stored = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4
      );
      const similarity = cosineSimilarity(queryEmbedding, stored);
      results.push({
        server: row.server,
        toolName: row.tool_name,
        description: row.description,
        similarity,
      });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  getDescription(server: string, toolName: string): string | undefined {
    const row = this.db.prepare(
      'SELECT description FROM tool_embeddings WHERE server = ? AND tool_name = ?'
    ).get(server, toolName) as { description: string } | undefined;
    return row?.description;
  }

  deleteServer(server: string): void {
    this.db.prepare('DELETE FROM tool_embeddings WHERE server = ?').run(server);
  }

  close(): void {
    this.db.close();
  }
}
