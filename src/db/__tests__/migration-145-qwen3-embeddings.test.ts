/**
 * Migration 145 — Qwen3 embedding provenance columns.
 *
 * Locks the shape the backfill worker + hybrid-scoring path rely on:
 *   agent_workforce_knowledge_chunks.embedding_model       TEXT, nullable
 *   agent_workforce_knowledge_chunks.embedding_updated_at  TEXT, nullable
 *
 * Both columns are optional so the migration can run against 425 pre-
 * existing rows without a backfill pass; the worker stamps them as it
 * embeds.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'src/db/migrations/145-qwen3-embeddings.sql',
);

/**
 * Mirrors the subset of migration 071 that creates the chunk table.
 * Keeping it inline means this test survives churn to older migrations.
 */
function createBaseChunkTable(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE agent_workforce_knowledge_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      summary TEXT,
      keywords TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding BLOB
    );
  `);
}

describe('migration 145 — Qwen3 embedding provenance', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createBaseChunkTable(db);
    const sql = readFileSync(MIGRATION_PATH, 'utf-8');
    db.exec(sql);
  });

  afterEach(() => {
    db.close();
  });

  it('adds embedding_model and embedding_updated_at columns', () => {
    const cols = db
      .prepare('PRAGMA table_info(agent_workforce_knowledge_chunks)')
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(byName.embedding_model).toBeDefined();
    expect(byName.embedding_model.type.toUpperCase()).toBe('TEXT');
    // Nullable — the backfill worker stamps this lazily on historical rows.
    expect(byName.embedding_model.notnull).toBe(0);

    expect(byName.embedding_updated_at).toBeDefined();
    expect(byName.embedding_updated_at.type.toUpperCase()).toBe('TEXT');
    expect(byName.embedding_updated_at.notnull).toBe(0);
  });

  it('preserves the pre-existing embedding column for chunk vectors', () => {
    const cols = db
      .prepare('PRAGMA table_info(agent_workforce_knowledge_chunks)')
      .all() as Array<{ name: string; type: string }>;
    const embedding = cols.find((c) => c.name === 'embedding');
    expect(embedding).toBeDefined();
    expect(embedding!.type.toUpperCase()).toBe('BLOB');
  });

  it('allows inserts that stamp the new provenance columns', () => {
    const insert = db.prepare(`
      INSERT INTO agent_workforce_knowledge_chunks
        (id, document_id, workspace_id, chunk_index, content, token_count,
         embedding, embedding_model, embedding_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const embedding = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    expect(() =>
      insert.run(
        'chunk-1',
        'doc-1',
        'ws-1',
        0,
        'hello world',
        2,
        embedding,
        'onnx-community/Qwen3-Embedding-0.6B-ONNX',
        '2026-04-18T12:00:00.000Z',
      ),
    ).not.toThrow();

    const row = db
      .prepare(
        `SELECT embedding_model, embedding_updated_at
           FROM agent_workforce_knowledge_chunks WHERE id = ?`,
      )
      .get('chunk-1') as { embedding_model: string; embedding_updated_at: string };
    expect(row.embedding_model).toBe('onnx-community/Qwen3-Embedding-0.6B-ONNX');
    expect(row.embedding_updated_at).toBe('2026-04-18T12:00:00.000Z');
  });

  it('allows pre-existing rows that leave the new columns NULL (backfill target)', () => {
    // Simulate one of the 425 historical rows: no embedding_model, no stamp.
    const insert = db.prepare(`
      INSERT INTO agent_workforce_knowledge_chunks
        (id, document_id, workspace_id, chunk_index, content, token_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    expect(() =>
      insert.run('legacy-1', 'doc-1', 'ws-1', 0, 'pre-Qwen3 chunk', 4),
    ).not.toThrow();

    const row = db
      .prepare(
        `SELECT embedding_model, embedding_updated_at
           FROM agent_workforce_knowledge_chunks WHERE id = ?`,
      )
      .get('legacy-1') as {
      embedding_model: string | null;
      embedding_updated_at: string | null;
    };
    expect(row.embedding_model).toBeNull();
    expect(row.embedding_updated_at).toBeNull();
  });
});
