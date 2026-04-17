import { describe, it, expect, vi } from 'vitest';
import {
  verdictForLift,
  insertBaseline,
  listPendingMeasurements,
  completeMeasurement,
  summarizeRecentVerdicts,
  type ExpectedLift,
  type LiftMeasurementRow,
} from '../lift-measurements-store.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

// -----------------------------------------------------------------------------
// Chainable mock DB that also supports .insert / .update / .is / .lte.
// -----------------------------------------------------------------------------

interface Table { rows: Record<string, unknown>[]; }

function buildDb(tables: Record<string, Table>): { db: DatabaseAdapter; tables: Record<string, Table> } {
  function makeBuilder(name: string) {
    if (!tables[name]) tables[name] = { rows: [] };
    const t = tables[name];
    const eqFilters: Array<{ col: string; val: unknown }> = [];
    const gteFilters: Array<{ col: string; val: unknown }> = [];
    const lteFilters: Array<{ col: string; val: unknown }> = [];
    const isFilters: Array<{ col: string; val: unknown }> = [];
    const apply = () =>
      t.rows.filter(
        (r) =>
          eqFilters.every((f) => r[f.col] === f.val) &&
          gteFilters.every((f) => String(r[f.col]) >= String(f.val)) &&
          lteFilters.every((f) => String(r[f.col]) <= String(f.val)) &&
          isFilters.every((f) => (f.val === null ? r[f.col] == null : r[f.col] === f.val)),
      );
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { eqFilters.push({ col, val }); return builder; };
    builder.gte = (col: string, val: unknown) => { gteFilters.push({ col, val }); return builder; };
    builder.lte = (col: string, val: unknown) => { lteFilters.push({ col, val }); return builder; };
    builder.is = (col: string, val: unknown) => { isFilters.push({ col, val }); return builder; };
    builder.order = () => builder;
    builder.limit = () => Promise.resolve({ data: apply(), error: null });
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: apply(), error: null });
    builder.insert = (values: Record<string, unknown>) => {
      // Apply defaults the real SQL would fill
      const row: Record<string, unknown> = {
        id: (values.id as string) ?? `row-${t.rows.length}`,
        created_at: (values.created_at as string) ?? new Date().toISOString(),
        post_value: null,
        post_at: null,
        signed_lift: null,
        verdict: null,
        baseline_value: null,
        ...values,
      };
      // Emulate UNIQUE (workspace_id, commit_sha, kpi_id, horizon_hours)
      const dupe = t.rows.find(
        (r) =>
          r.workspace_id === row.workspace_id &&
          r.commit_sha === row.commit_sha &&
          r.kpi_id === row.kpi_id &&
          r.horizon_hours === row.horizon_hours,
      );
      if (dupe) return Promise.resolve({ data: null, error: { message: 'UNIQUE constraint failed' } });
      t.rows.push(row);
      return Promise.resolve({ data: null, error: null });
    };
    builder.update = (patch: Record<string, unknown>) => {
      const chainable: Record<string, unknown> = {};
      const updateEq: Array<{ col: string; val: unknown }> = [];
      chainable.eq = (col: string, val: unknown) => { updateEq.push({ col, val }); return chainable; };
      chainable.then = (resolve: (v: unknown) => void) => {
        const matched = t.rows.filter((r) => updateEq.every((f) => r[f.col] === f.val));
        for (const r of matched) Object.assign(r, patch);
        resolve({ data: null, error: null });
      };
      return chainable;
    };
    return builder;
  }
  return {
    tables,
    db: { from: vi.fn().mockImplementation((n: string) => makeBuilder(n)) } as unknown as DatabaseAdapter,
  };
}

// -----------------------------------------------------------------------------

describe('verdictForLift', () => {
  it("returns 'unmeasured' when lift is null or non-finite", () => {
    expect(verdictForLift('revenue_cents_24h', null, 'up')).toBe('unmeasured');
    expect(verdictForLift('revenue_cents_24h', NaN, 'up')).toBe('unmeasured');
    expect(verdictForLift('revenue_cents_24h', Infinity, 'up')).toBe('unmeasured');
  });

  it("returns 'flat' when |lift| is within tolerance for the KPI unit", () => {
    // cents tolerance = 50
    expect(verdictForLift('revenue_cents_24h', 25, 'up')).toBe('flat');
    expect(verdictForLift('revenue_cents_24h', -40, 'up')).toBe('flat');
    expect(verdictForLift('revenue_cents_24h', 50, 'up')).toBe('flat');
    // count tolerance = 1
    expect(verdictForLift('outbound_dm_24h', 1, 'up')).toBe('flat');
    expect(verdictForLift('outbound_dm_24h', 0, 'up')).toBe('flat');
    // ratio tolerance = 0.02
    expect(verdictForLift('reply_ratio_24h', 0.01, 'up')).toBe('flat');
    expect(verdictForLift('reply_ratio_24h', -0.02, 'up')).toBe('flat');
  });

  it("returns 'moved_right' for positive lift above tolerance", () => {
    expect(verdictForLift('revenue_cents_24h', 1000, 'up')).toBe('moved_right');
    expect(verdictForLift('revenue_cents_24h', 500, 'any')).toBe('moved_right');
    expect(verdictForLift('burn_cents_today', 200, 'down')).toBe('moved_right');
  });

  it("returns 'moved_wrong' for negative lift below -tolerance", () => {
    expect(verdictForLift('revenue_cents_24h', -200, 'up')).toBe('moved_wrong');
    expect(verdictForLift('reply_ratio_24h', -0.1, 'any')).toBe('moved_wrong');
  });

  it("treats unknown KPIs with zero tolerance", () => {
    // unknown kpi → tolerance 0, any non-zero lift is movement
    expect(verdictForLift('bogus_kpi', 0, 'up')).toBe('flat');
    expect(verdictForLift('bogus_kpi', 1, 'up')).toBe('moved_right');
    expect(verdictForLift('bogus_kpi', -1, 'up')).toBe('moved_wrong');
  });
});

describe('insertBaseline', () => {
  const expected: ExpectedLift = { kpiId: 'revenue_cents_24h', direction: 'up', horizonHours: 24 };

  it('inserts a row with correctly computed measure_at', async () => {
    const { db, tables } = buildDb({});
    const n = await insertBaseline(db, {
      workspaceId: 'ws-1',
      commitSha: 'abc123',
      expected,
      baselineValue: 500,
      baselineAt: '2026-04-16T00:00:00.000Z',
      sourceExperimentId: 'patch-author',
    });
    expect(n).toBe(1);
    const r = tables.lift_measurements.rows[0];
    expect(r.commit_sha).toBe('abc123');
    expect(r.kpi_id).toBe('revenue_cents_24h');
    expect(r.horizon_hours).toBe(24);
    expect(r.baseline_value).toBe(500);
    expect(r.expected_direction).toBe('up');
    expect(r.source_experiment_id).toBe('patch-author');
    // +24h
    expect(r.measure_at).toBe('2026-04-17T00:00:00.000Z');
  });

  it('skips unknown KPI ids without throwing', async () => {
    const { db, tables } = buildDb({});
    const n = await insertBaseline(db, {
      workspaceId: 'ws-1',
      commitSha: 'abc',
      expected: { kpiId: 'nope', direction: 'up', horizonHours: 24 },
      baselineValue: 1,
      baselineAt: '2026-04-16T00:00:00.000Z',
    });
    expect(n).toBe(0);
    expect(tables.lift_measurements?.rows?.length ?? 0).toBe(0);
  });

  it('swallows UNIQUE collisions on retry', async () => {
    const { db } = buildDb({});
    const args = {
      workspaceId: 'ws-1',
      commitSha: 'abc',
      expected,
      baselineValue: 1,
      baselineAt: '2026-04-16T00:00:00.000Z',
    };
    const first = await insertBaseline(db, args);
    const second = await insertBaseline(db, args);
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it('accepts null baseline_value (read error case)', async () => {
    const { db, tables } = buildDb({});
    const n = await insertBaseline(db, {
      workspaceId: 'ws-1',
      commitSha: 'abc',
      expected,
      baselineValue: null,
      baselineAt: '2026-04-16T00:00:00.000Z',
    });
    expect(n).toBe(1);
    expect(tables.lift_measurements.rows[0].baseline_value).toBeNull();
  });
});

describe('listPendingMeasurements', () => {
  it('returns rows whose measure_at has passed and post_at is null', async () => {
    const past = { measure_at: '2026-04-16T00:00:00.000Z', post_at: null };
    const future = { measure_at: '2026-04-20T00:00:00.000Z', post_at: null };
    const closed = { measure_at: '2026-04-16T00:00:00.000Z', post_at: '2026-04-17T00:00:00.000Z' };
    const { db } = buildDb({
      lift_measurements: {
        rows: [
          { ...past, id: 'a', workspace_id: 'ws-1' },
          { ...future, id: 'b', workspace_id: 'ws-1' },
          { ...closed, id: 'c', workspace_id: 'ws-1' },
          { ...past, id: 'd', workspace_id: 'ws-other' }, // different workspace
        ],
      },
    });
    const rows = await listPendingMeasurements(db, 'ws-1', '2026-04-17T00:00:00.000Z');
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['a']);
  });
});

describe('completeMeasurement', () => {
  it('updates the row and returns moved_right verdict on positive lift', async () => {
    const { db, tables } = buildDb({
      lift_measurements: {
        rows: [
          {
            id: 'x',
            workspace_id: 'ws-1',
            commit_sha: 'abc',
            kpi_id: 'revenue_cents_24h',
            expected_direction: 'up',
            horizon_hours: 24,
            baseline_value: 500,
            baseline_at: '2026-04-16T00:00:00.000Z',
            measure_at: '2026-04-17T00:00:00.000Z',
            post_value: null,
            post_at: null,
            signed_lift: null,
            verdict: null,
          },
        ],
      },
    });
    const row = tables.lift_measurements.rows[0] as unknown as LiftMeasurementRow;
    const verdict = await completeMeasurement(db, row, {
      id: 'x',
      postValue: 2000,
      postAt: '2026-04-17T00:00:00.000Z',
    });
    expect(verdict).toBe('moved_right');
    const updated = tables.lift_measurements.rows[0];
    expect(updated.post_value).toBe(2000);
    expect(updated.signed_lift).toBe(1500);
    expect(updated.verdict).toBe('moved_right');
  });

  it('returns moved_wrong when KPI went the wrong way', async () => {
    const { db, tables } = buildDb({
      lift_measurements: {
        rows: [
          {
            id: 'x',
            workspace_id: 'ws-1',
            commit_sha: 'abc',
            kpi_id: 'revenue_cents_24h',
            expected_direction: 'up',
            horizon_hours: 24,
            baseline_value: 1000,
            baseline_at: '2026-04-16T00:00:00.000Z',
            measure_at: '2026-04-17T00:00:00.000Z',
            post_value: null, post_at: null, signed_lift: null, verdict: null,
          },
        ],
      },
    });
    const row = tables.lift_measurements.rows[0] as unknown as LiftMeasurementRow;
    const v = await completeMeasurement(db, row, {
      id: 'x',
      postValue: 100,
      postAt: '2026-04-17T00:00:00.000Z',
    });
    expect(v).toBe('moved_wrong');
  });

  it('returns unmeasured when post_value is null', async () => {
    const { db, tables } = buildDb({
      lift_measurements: {
        rows: [
          {
            id: 'x',
            workspace_id: 'ws-1',
            commit_sha: 'abc',
            kpi_id: 'revenue_cents_24h',
            expected_direction: 'up',
            horizon_hours: 24,
            baseline_value: 500,
            baseline_at: '2026-04-16T00:00:00.000Z',
            measure_at: '2026-04-17T00:00:00.000Z',
            post_value: null, post_at: null, signed_lift: null, verdict: null,
          },
        ],
      },
    });
    const row = tables.lift_measurements.rows[0] as unknown as LiftMeasurementRow;
    const v = await completeMeasurement(db, row, {
      id: 'x',
      postValue: null,
      postAt: '2026-04-17T00:00:00.000Z',
    });
    expect(v).toBe('unmeasured');
    expect(tables.lift_measurements.rows[0].verdict).toBe('unmeasured');
  });
});

describe('summarizeRecentVerdicts', () => {
  it('counts verdict distribution for closed rows only', async () => {
    const { db } = buildDb({
      lift_measurements: {
        rows: [
          { workspace_id: 'ws-1', verdict: 'moved_right', post_at: '2026-04-16T12:00:00.000Z' },
          { workspace_id: 'ws-1', verdict: 'moved_right', post_at: '2026-04-16T13:00:00.000Z' },
          { workspace_id: 'ws-1', verdict: 'moved_wrong', post_at: '2026-04-16T14:00:00.000Z' },
          { workspace_id: 'ws-1', verdict: 'flat', post_at: '2026-04-16T15:00:00.000Z' },
          { workspace_id: 'ws-1', verdict: null, post_at: null }, // still pending
          { workspace_id: 'ws-other', verdict: 'moved_right', post_at: '2026-04-16T12:00:00.000Z' }, // excluded
        ],
      },
    });
    const s = await summarizeRecentVerdicts(db, 'ws-1', '2026-04-16T00:00:00.000Z');
    expect(s).toEqual({
      moved_right: 2,
      moved_wrong: 1,
      flat: 1,
      unmeasured: 0,
      total_closed: 4,
    });
  });
});
