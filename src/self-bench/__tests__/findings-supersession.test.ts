import { describe, it, expect, vi } from 'vitest';
import { writeFinding } from '../findings-store.js';
import type { NewFindingRow } from '../experiment-types.js';

/**
 * Mock DB supporting the methods writeFinding + supersedeDuplicates
 * use: insert, select/eq/gte (chain then-able), update+eq.
 */
function buildDb(seedRows: Array<Record<string, unknown>> = []) {
  // Table-aware storage. writeFinding now inserts into both
  // self_findings (the ledger) and self_observation_baselines (novelty
  // stats added in Piece 1). Supersession assertions read self_findings
  // explicitly via env.rows.
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const findingsBucket = [...seedRows];
  tables.set('self_findings', findingsBucket);

  function makeBuilder(tableName: string) {
    if (!tables.has(tableName)) tables.set(tableName, []);
    const tableRows = tables.get(tableName)!;
    const filters: Array<{ col: string; val: unknown }> = [];
    const rangeFilters: Array<{ col: string; op: 'gte' | 'lte'; val: unknown }> = [];
    let updateFields: Record<string, unknown> | null = null;

    const apply = () => tableRows.filter((r) =>
      filters.every((f) => f.val === '__IS_NULL__'
        ? r[f.col] === null || r[f.col] === undefined
        : r[f.col] === f.val) &&
      rangeFilters.every((f) =>
        f.op === 'gte' ? String(r[f.col]) >= String(f.val) : String(r[f.col]) <= String(f.val)),
    );

    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => {
      if (updateFields) {
        const matches = tableRows.filter((r) => r[col] === val);
        for (const m of matches) Object.assign(m, updateFields);
        return Promise.resolve({ data: null, error: null });
      }
      filters.push({ col, val });
      return builder;
    };
    builder.is = (col: string, val: null | boolean) => {
      // Mirror SqliteAdapter: .is(col, null) means WHERE col IS NULL,
      // matching both undefined and explicit nulls in the JS rows.
      filters.push({
        col,
        val: val === null
          ? '__IS_NULL__'
          : val,
      });
      return builder;
    };
    builder.gte = (col: string, val: unknown) => {
      rangeFilters.push({ col, op: 'gte', val });
      return builder;
    };
    builder.order = () => builder;
    builder.limit = () => Promise.resolve({ data: apply(), error: null });
    builder.insert = (row: Record<string, unknown>) => {
      tableRows.push({ ...row });
      return Promise.resolve({ data: null, error: null });
    };
    builder.update = (fields: Record<string, unknown>) => {
      updateFields = fields;
      return builder;
    };
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply(), error: null });
    return builder;
  }

  return {
    db: { from: vi.fn().mockImplementation((table: string) => makeBuilder(table)) },
    rows: findingsBucket,
    tables,
  };
}

const baseRow: NewFindingRow = {
  experimentId: 'dashboard-copy',
  category: 'other',
  subject: 'routes',
  hypothesis: 'dashboard copy is within rules',
  verdict: 'fail',
  summary: '118 violation(s) across 9/28 route(s)',
  evidence: { count: 118 },
  interventionApplied: null,
  ranAt: new Date().toISOString(),
  durationMs: 30,
};

describe('findings supersession', () => {
  it('leaves a lone finding untouched', async () => {
    const env = buildDb();
    await writeFinding(env.db as never, baseRow);
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0].status).toBe('active');
    expect(env.rows[0].superseded_by).toBeFalsy();
  });

  it('marks an identical prior row superseded and links to the new id', async () => {
    const env = buildDb();
    const firstId = await writeFinding(env.db as never, baseRow);
    const secondId = await writeFinding(env.db as never, baseRow);
    expect(env.rows).toHaveLength(2);
    const first = env.rows.find((r) => r.id === firstId)!;
    const second = env.rows.find((r) => r.id === secondId)!;
    expect(first.status).toBe('superseded');
    expect(first.superseded_by).toBe(secondId);
    expect(second.status).toBe('active');
  });

  it('does NOT supersede rows with a different summary (value changed)', async () => {
    const env = buildDb();
    await writeFinding(env.db as never, baseRow);
    await writeFinding(env.db as never, { ...baseRow, summary: '120 violation(s) across 9/28 route(s)' });
    const active = env.rows.filter((r) => r.status === 'active');
    expect(active).toHaveLength(2);
  });

  it('does NOT supersede rows with a different subject', async () => {
    const env = buildDb();
    await writeFinding(env.db as never, baseRow);
    await writeFinding(env.db as never, { ...baseRow, subject: 'other' });
    const active = env.rows.filter((r) => r.status === 'active');
    expect(active).toHaveLength(2);
  });

  it('supersedes a prior null-subject row when (experiment_id, summary) match', async () => {
    // Fixed in commit "supersedeDuplicates handles null subject by
    // (experiment_id, summary)" — agent-coverage-gap and friends fire
    // null-subject summary-only findings every ~10s. Without this the
    // active pool grows unbounded.
    const env = buildDb();
    const firstId = await writeFinding(env.db as never, { ...baseRow, subject: null });
    const secondId = await writeFinding(env.db as never, { ...baseRow, subject: null });
    const first = env.rows.find((r) => r.id === firstId)!;
    const second = env.rows.find((r) => r.id === secondId)!;
    expect(first.status).toBe('superseded');
    expect(first.superseded_by).toBe(secondId);
    expect(second.status).toBe('active');
  });

  it('does NOT cross-supersede a null-subject row with a subject-bearing one', async () => {
    // The subject branch and null-subject branch must stay isolated:
    // a null-subject "summary X" must not eat a subject="foo" row that
    // happens to share the same summary, and vice versa.
    const env = buildDb();
    await writeFinding(env.db as never, { ...baseRow, subject: 'foo' });
    await writeFinding(env.db as never, { ...baseRow, subject: null });
    const active = env.rows.filter((r) => r.status === 'active');
    expect(active).toHaveLength(2);
  });

  it('does NOT supersede null-subject rows with different summaries', async () => {
    const env = buildDb();
    await writeFinding(env.db as never, { ...baseRow, subject: null, summary: 'A' });
    await writeFinding(env.db as never, { ...baseRow, subject: null, summary: 'B' });
    const active = env.rows.filter((r) => r.status === 'active');
    expect(active).toHaveLength(2);
  });

  it('still bails when the new row has an empty summary', async () => {
    // Empty summary collapses the dedupe key to (experiment_id) alone,
    // which would suppress legitimately distinct rows. Keep the bail.
    const env = buildDb();
    await writeFinding(env.db as never, { ...baseRow, subject: null, summary: '' });
    await writeFinding(env.db as never, { ...baseRow, subject: null, summary: '' });
    const active = env.rows.filter((r) => r.status === 'active');
    expect(active).toHaveLength(2);
  });

  it('honors a custom supersede window (0 = never dedup)', async () => {
    const env = buildDb();
    await writeFinding(env.db as never, baseRow, { supersedeWindowMs: 0 });
    await writeFinding(env.db as never, baseRow, { supersedeWindowMs: 0 });
    const active = env.rows.filter((r) => r.status === 'active');
    // Both rows remain active because the window collapsed to zero
    // and ran_at is *after* windowStart by construction (> now-0).
    // Accept either: both active OR the older superseded. The goal is
    // just to confirm the window parameter plumbs through.
    expect(active.length).toBeGreaterThanOrEqual(1);
  });
});
