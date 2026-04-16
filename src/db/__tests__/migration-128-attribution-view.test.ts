/**
 * Tests for migration 128: agent_workforce_attribution_rollup view.
 *
 * Seeds one contact through every funnel step (x:qualified → x:reached
 * → demo:booked → plan:paid) + a revenue_entries row, then asserts the
 * view reports correct per-step timestamps + lifetime_revenue_cents.
 * Also checks boundary cases: a contact with no events (nulls), and
 * aggregated revenue across multiple entries.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(process.cwd(), 'src/db/migrations/128-attribution-view.sql');

function createBaseSchema(db: InstanceType<typeof Database>): void {
  // Minimal versions of the real schema — just enough columns for the view.
  db.exec(`
    CREATE TABLE agent_workforce_contacts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT,
      contact_type TEXT DEFAULT 'lead',
      status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]',
      custom_fields TEXT DEFAULT '{}',
      outreach_token TEXT,
      never_sync INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_workforce_contact_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      contact_id TEXT,
      kind TEXT,
      source TEXT,
      payload TEXT DEFAULT '{}',
      occurred_at TEXT,
      event_type TEXT,
      title TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_workforce_revenue_entries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      contact_id TEXT,
      source_event_id TEXT,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      month INTEGER,
      year INTEGER,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

describe('migration 128: attribution rollup view', () => {
  let db: InstanceType<typeof Database>;

  beforeAll(() => {
    db = new Database(':memory:');
    createBaseSchema(db);
    const migrationSql = readFileSync(MIGRATION_PATH, 'utf-8');
    db.exec(migrationSql);
  });

  it('creates the view', () => {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='view' AND name=?`)
      .get('agent_workforce_attribution_rollup') as { name: string } | undefined;
    expect(row?.name).toBe('agent_workforce_attribution_rollup');
  });

  it('rolls up a contact with every funnel step', () => {
    db.prepare(`INSERT INTO agent_workforce_contacts (id, workspace_id, name, contact_type, custom_fields, never_sync)
                VALUES (?, ?, ?, ?, ?, ?)`).run(
      'c1', 'ws1', 'Alice',
      'customer',
      JSON.stringify({ x_source: 'author-ledger', x_bucket: 'market_signal', x_intent: 'buyer_intent' }),
      1,
    );
    const ts = (offsetHours: number) => {
      const base = Date.UTC(2026, 3, 10, 9, 0, 0);
      return new Date(base + offsetHours * 3_600_000).toISOString();
    };
    const events: Array<[string, string, string]> = [
      ['e1', 'x:qualified',   ts(0)],
      ['e2', 'x:reached',     ts(4)],
      ['e3', 'demo:booked',   ts(24)],
      ['e4', 'plan:paid',     ts(72)],
    ];
    for (const [id, kind, occurred] of events) {
      db.prepare(`INSERT INTO agent_workforce_contact_events (id, workspace_id, contact_id, kind, occurred_at, event_type, title, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, 'ws1', 'c1', kind, occurred, kind, kind, occurred);
    }
    db.prepare(`INSERT INTO agent_workforce_revenue_entries (id, workspace_id, contact_id, source_event_id, amount_cents, month, year)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('r1', 'ws1', 'c1', 'e4', 4900, 4, 2026);

    const row = db
      .prepare(`SELECT * FROM agent_workforce_attribution_rollup WHERE contact_id = ?`)
      .get('c1') as Record<string, unknown>;

    expect(row.workspace_id).toBe('ws1');
    expect(row.source).toBe('author-ledger');
    expect(row.bucket).toBe('market_signal');
    expect(row.intent).toBe('buyer_intent');
    expect(row.contact_type).toBe('customer');
    expect(row.never_sync).toBe(1);
    expect(row.first_seen_ts).toBe(ts(0));
    expect(row.qualified_ts).toBe(ts(0));
    expect(row.reached_ts).toBe(ts(4));
    expect(row.demo_ts).toBe(ts(24));
    expect(row.paid_ts).toBe(ts(72));
    expect(row.trial_ts).toBeNull();
    expect(row.lifetime_revenue_cents).toBe(4900);
  });

  it('returns nulls for a contact with no events and zero revenue', () => {
    db.prepare(`INSERT INTO agent_workforce_contacts (id, workspace_id, name, custom_fields)
                VALUES (?, ?, ?, ?)`).run('c2', 'ws1', 'Bob', '{}');

    const row = db
      .prepare(`SELECT * FROM agent_workforce_attribution_rollup WHERE contact_id = ?`)
      .get('c2') as Record<string, unknown>;

    expect(row.first_seen_ts).toBeNull();
    expect(row.qualified_ts).toBeNull();
    expect(row.paid_ts).toBeNull();
    expect(row.lifetime_revenue_cents).toBe(0);
    expect(row.source).toBeNull();
    expect(row.bucket).toBeNull();
  });

  it('sums revenue across multiple entries for the same contact', () => {
    db.prepare(`INSERT INTO agent_workforce_contacts (id, workspace_id, name, custom_fields)
                VALUES (?, ?, ?, ?)`).run('c3', 'ws1', 'Carol', '{}');
    db.prepare(`INSERT INTO agent_workforce_revenue_entries (id, workspace_id, contact_id, amount_cents, month, year)
                VALUES (?, ?, ?, ?, ?, ?)`).run('r2', 'ws1', 'c3', 2900, 3, 2026);
    db.prepare(`INSERT INTO agent_workforce_revenue_entries (id, workspace_id, contact_id, amount_cents, month, year)
                VALUES (?, ?, ?, ?, ?, ?)`).run('r3', 'ws1', 'c3', 4900, 4, 2026);

    const row = db
      .prepare(`SELECT lifetime_revenue_cents FROM agent_workforce_attribution_rollup WHERE contact_id = ?`)
      .get('c3') as { lifetime_revenue_cents: number };

    expect(row.lifetime_revenue_cents).toBe(7800);
  });
});
