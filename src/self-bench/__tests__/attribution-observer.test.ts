/**
 * Tests for AttributionObserverExperiment.
 *
 * Uses an in-memory sqlite with the real migration-128 view applied
 * so probe exercises the same query surface it will in production.
 * runtime_config writes go through the real setRuntimeConfig.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSqliteAdapter } from '../../db/sqlite-adapter.js';
import { AttributionObserverExperiment, type AttributionEvidence } from '../experiments/attribution-observer.js';
import {
  _resetRuntimeConfigCacheForTests,
  refreshRuntimeConfigCache,
} from '../runtime-config.js';
import type { ExperimentContext } from '../experiment-types.js';

const VIEW_MIGRATION = resolve(process.cwd(), 'src/db/migrations/128-attribution-view.sql');

function seedSchema(rawDb: InstanceType<typeof Database>): void {
  rawDb.exec(`
    CREATE TABLE agent_workforce_contacts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT,
      contact_type TEXT DEFAULT 'lead',
      status TEXT DEFAULT 'active',
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
    CREATE TABLE runtime_config_overrides (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      set_by TEXT,
      finding_id TEXT,
      set_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  rawDb.exec(readFileSync(VIEW_MIGRATION, 'utf-8'));
}

interface SeedRow {
  id: string;
  bucket?: string;
  source?: string;
  qualified: boolean;
  paid: boolean;
  daysBetween?: number;
  revenueCents?: number;
}

function insertFunnelRow(rawDb: InstanceType<typeof Database>, row: SeedRow): void {
  const customFields = JSON.stringify({
    x_source: row.source ?? 'author-ledger',
    x_bucket: row.bucket ?? 'market_signal',
  });
  rawDb.prepare(`INSERT INTO agent_workforce_contacts (id, workspace_id, name, custom_fields)
                 VALUES (?, ?, ?, ?)`)
    .run(row.id, 'ws1', `Contact ${row.id}`, customFields);
  if (!row.qualified) return;
  const qualifiedIso = new Date(Date.UTC(2026, 3, 1, 9, 0, 0)).toISOString();
  rawDb.prepare(`INSERT INTO agent_workforce_contact_events (id, workspace_id, contact_id, kind, occurred_at, event_type, title, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`qe-${row.id}`, 'ws1', row.id, 'x:qualified', qualifiedIso, 'x:qualified', 'x:qualified', qualifiedIso);
  if (!row.paid) return;
  const paidMs = Date.UTC(2026, 3, 1, 9, 0, 0) + (row.daysBetween ?? 7) * 24 * 60 * 60 * 1000;
  const paidIso = new Date(paidMs).toISOString();
  rawDb.prepare(`INSERT INTO agent_workforce_contact_events (id, workspace_id, contact_id, kind, occurred_at, event_type, title, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`pe-${row.id}`, 'ws1', row.id, 'plan:paid', paidIso, 'plan:paid', 'plan:paid', paidIso);
  rawDb.prepare(`INSERT INTO agent_workforce_revenue_entries (id, workspace_id, contact_id, source_event_id, amount_cents, month, year)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`r-${row.id}`, 'ws1', row.id, `pe-${row.id}`, row.revenueCents ?? 4900, 4, 2026);
}

describe('AttributionObserverExperiment', () => {
  let rawDb: InstanceType<typeof Database>;
  let adapter: ReturnType<typeof createSqliteAdapter>;

  beforeEach(async () => {
    _resetRuntimeConfigCacheForTests();
    rawDb = new Database(':memory:');
    seedSchema(rawDb);
    adapter = createSqliteAdapter(rawDb);
    await refreshRuntimeConfigCache(adapter);
  });

  afterEach(() => {
    _resetRuntimeConfigCacheForTests();
    rawDb.close();
  });

  function makeCtx(): ExperimentContext {
    return {
      db: adapter as never,
      workspaceId: 'ws1',
      workspaceSlug: 'default',
      engine: {} as never,
      recentFindings: async () => [],
    };
  }

  it('passes with low sample and writes neutral findings', async () => {
    insertFunnelRow(rawDb, { id: 'c1', qualified: true, paid: false });
    const exp = new AttributionObserverExperiment();
    const probe = await exp.probe(makeCtx());
    expect(exp.judge(probe, [])).toBe('pass');
    const ev = probe.evidence as AttributionEvidence;
    expect(ev.total_qualified).toBe(1);
    expect(ev.total_paid).toBe(0);
    expect(ev.overall_conversion_rate).toBe(0);
  });

  it('warns when a bucket with enough sample has zero conversions', async () => {
    for (const id of ['a1', 'a2', 'a3']) {
      insertFunnelRow(rawDb, { id, bucket: 'competitors', qualified: true, paid: false });
    }
    const exp = new AttributionObserverExperiment();
    const probe = await exp.probe(makeCtx());
    expect(exp.judge(probe, [])).toBe('warning');
    const ev = probe.evidence as AttributionEvidence;
    expect(ev.worst_performing_bucket?.bucket).toBe('competitors');
    expect(ev.worst_performing_bucket?.conversion_rate).toBe(0);
  });

  it('passes when every bucket with sample converts', async () => {
    for (const id of ['a1', 'a2', 'a3']) {
      insertFunnelRow(rawDb, { id, bucket: 'market_signal', qualified: true, paid: true, daysBetween: 5 });
    }
    const exp = new AttributionObserverExperiment();
    const probe = await exp.probe(makeCtx());
    expect(exp.judge(probe, [])).toBe('pass');
    const ev = probe.evidence as AttributionEvidence;
    expect(ev.total_paid).toBe(3);
    expect(ev.overall_conversion_rate).toBe(1);
    expect(ev.median_days_to_paid).toBe(5);
  });

  it('reports per-bucket stats with median days to paid', async () => {
    insertFunnelRow(rawDb, { id: 'a1', bucket: 'market_signal', qualified: true, paid: true, daysBetween: 3 });
    insertFunnelRow(rawDb, { id: 'a2', bucket: 'market_signal', qualified: true, paid: true, daysBetween: 7 });
    insertFunnelRow(rawDb, { id: 'a3', bucket: 'market_signal', qualified: true, paid: true, daysBetween: 14 });
    insertFunnelRow(rawDb, { id: 'b1', bucket: 'competitors', qualified: true, paid: false });
    insertFunnelRow(rawDb, { id: 'b2', bucket: 'competitors', qualified: true, paid: false });
    insertFunnelRow(rawDb, { id: 'b3', bucket: 'competitors', qualified: true, paid: false });

    const exp = new AttributionObserverExperiment();
    const probe = await exp.probe(makeCtx());
    const ev = probe.evidence as AttributionEvidence;

    const msBucket = ev.by_bucket.find((b) => b.bucket === 'market_signal');
    expect(msBucket?.qualified).toBe(3);
    expect(msBucket?.paid).toBe(3);
    expect(msBucket?.median_days_to_paid).toBe(7); // median of [3, 7, 14]

    const compBucket = ev.by_bucket.find((b) => b.bucket === 'competitors');
    expect(compBucket?.conversion_rate).toBe(0);
    expect(compBucket?.median_days_to_paid).toBeNull();

    // Worst bucket is competitors (zero conversion).
    expect(ev.worst_performing_bucket?.bucket).toBe('competitors');
  });

  it('intervene writes strategy.attribution_findings on pass and warning', async () => {
    for (const id of ['a1', 'a2', 'a3']) {
      insertFunnelRow(rawDb, { id, bucket: 'competitors', qualified: true, paid: false });
    }
    const exp = new AttributionObserverExperiment();
    const probe = await exp.probe(makeCtx());
    const verdict = exp.judge(probe, []);
    const intervention = await exp.intervene(verdict, probe, makeCtx());
    expect(intervention?.description).toContain('attribution findings');

    const row = rawDb.prepare(`SELECT value FROM runtime_config_overrides WHERE key = ?`)
      .get('strategy.attribution_findings') as { value: string } | undefined;
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.value) as { verdict: string; total_qualified: number; worst_performing_bucket: { bucket: string } };
    expect(parsed.verdict).toBe('warning');
    expect(parsed.total_qualified).toBe(3);
    expect(parsed.worst_performing_bucket.bucket).toBe('competitors');
  });

  it('skips probe on non-default workspace', async () => {
    const nonDefaultCtx: ExperimentContext = { ...makeCtx(), workspaceSlug: 'other' };
    const exp = new AttributionObserverExperiment();
    const probe = await exp.probe(nonDefaultCtx);
    expect(exp.judge(probe, [])).toBe('pass');
    const intervention = await exp.intervene('pass', probe, nonDefaultCtx);
    expect(intervention).toBeNull();
  });

  it('handles the empty-view case gracefully', async () => {
    const exp = new AttributionObserverExperiment();
    const probe = await exp.probe(makeCtx());
    expect(exp.judge(probe, [])).toBe('pass');
    const ev = probe.evidence as AttributionEvidence;
    expect(ev.total_contacts).toBe(0);
    expect(ev.total_qualified).toBe(0);
    expect(ev.by_bucket).toEqual([]);
    expect(ev.worst_performing_bucket).toBeNull();
  });
});
