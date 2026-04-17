/**
 * lift-pipeline-stress — adversarial tests for the Phase 5 outcome loop.
 *
 * The happy-path tests in lift-measurements-store.test.ts and
 * lift-measurement.test.ts verify one-row-at-a-time behavior. This
 * file probes the loop under realistic pressure:
 *
 *   - Concurrent insertBaseline calls racing on the (workspace, sha,
 *     kpi, horizon) UNIQUE constraint. Both promises must resolve
 *     cleanly; exactly one row must land.
 *   - Clock skew: baseline_at in the future (daemon restart + bad NTP)
 *     must push measure_at further out, not panic. Unparseable
 *     baseline_at must return 0 instead of NaN-poisoning measure_at.
 *   - Workspace-id rewrite orphaning: when the daemon's consolidation
 *     step flips workspace_id from 'local' to a cloud UUID, any
 *     pending rows inserted under the old id must not be
 *     silently-orphaned without the test surfacing it. This test
 *     documents the current (broken) behavior as a tripwire — if the
 *     consolidator grows a rewrite step, the test should be updated
 *     to reflect the fix.
 *   - Mixed-verdict batch: one KPI-read failure in the middle of a
 *     batch must not abort the rest. The probe closes every row it
 *     can; failed reads land as verdict='unmeasured'.
 *   - Pending batch cap: 100 rows due → 50 closed per tick (the
 *     PENDING_BATCH_LIMIT). Remaining rows stay pending for the next
 *     tick. Protects the tick budget from unbounded backlog drain.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  insertBaseline,
  listPendingMeasurements,
  type ExpectedLift,
} from '../lift-measurements-store.js';
import { LiftMeasurementExperiment, type LiftMeasurementEvidence } from '../experiments/lift-measurement.js';
import type { ExperimentContext } from '../experiment-types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

// -----------------------------------------------------------------------------
// Shared chainable mock adapter. Mirrors the helpers in the sibling
// test files — kept local for self-containment. Supports select / eq /
// gte / lte / is / order / limit / insert / update, plus the UNIQUE
// constraint the real schema enforces on lift_measurements.

interface Table { rows: Record<string, unknown>[]; }

function buildDb(tables: Record<string, Table>): DatabaseAdapter {
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
    let limitN = Infinity;
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { eqFilters.push({ col, val }); return builder; };
    builder.gte = (col: string, val: unknown) => { gteFilters.push({ col, val }); return builder; };
    builder.lte = (col: string, val: unknown) => { lteFilters.push({ col, val }); return builder; };
    builder.is = (col: string, val: unknown) => { isFilters.push({ col, val }); return builder; };
    builder.order = () => builder;
    builder.limit = (n: number) => { limitN = n; return Promise.resolve({ data: apply().slice(0, limitN), error: null }); };
    builder.then = (resolve: (v: unknown) => void) =>
      resolve({ data: apply().slice(0, limitN), error: null });
    builder.insert = (values: Record<string, unknown>) => {
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
      const dupe = t.rows.find(
        (r) =>
          r.workspace_id === row.workspace_id &&
          r.commit_sha === row.commit_sha &&
          r.kpi_id === row.kpi_id &&
          r.horizon_hours === row.horizon_hours,
      );
      if (dupe) {
        return Promise.resolve({ data: null, error: { message: 'UNIQUE constraint failed' } });
      }
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
  return { from: vi.fn().mockImplementation((n: string) => makeBuilder(n)) } as unknown as DatabaseAdapter;
}

function ctxFor(db: DatabaseAdapter, workspaceId = 'ws-1'): ExperimentContext {
  return {
    db,
    workspaceId,
    workspaceSlug: 'default',
    engine: {} as never,
    recentFindings: async () => [],
  };
}

const EXPECTED: ExpectedLift = {
  kpiId: 'revenue_cents_24h',
  direction: 'up',
  horizonHours: 24,
};

// -----------------------------------------------------------------------------

describe('insertBaseline under concurrency', () => {
  it('two concurrent inserts on the same key land exactly one row', async () => {
    const tables: Record<string, Table> = {};
    const db = buildDb(tables);
    const args = {
      workspaceId: 'ws-1',
      commitSha: 'race-sha',
      expected: EXPECTED,
      baselineValue: 100,
      baselineAt: '2026-04-16T00:00:00.000Z',
    };
    const [a, b] = await Promise.all([insertBaseline(db, args), insertBaseline(db, args)]);
    // Exactly one winner — the other must return 0 without throwing.
    expect(a + b).toBe(1);
    expect(tables.lift_measurements.rows.length).toBe(1);
  });

  it('ten concurrent inserts across the same commit + two KPIs land exactly two rows', async () => {
    // Models the real collision pattern: a single commit registers
    // multiple KPIs, and the recorder closure fires one per KPI. If
    // the recorder retries (e.g. safeSelfCommit re-entry), the same
    // (sha, kpi, horizon) tuple shows up again — must not duplicate.
    const tables: Record<string, Table> = {};
    const db = buildDb(tables);
    const base = {
      workspaceId: 'ws-1',
      commitSha: 'multi-sha',
      baselineValue: 50,
      baselineAt: '2026-04-16T00:00:00.000Z',
    };
    const jobs = [
      ...Array.from({ length: 5 }, () =>
        insertBaseline(db, { ...base, expected: EXPECTED }),
      ),
      ...Array.from({ length: 5 }, () =>
        insertBaseline(db, {
          ...base,
          expected: { kpiId: 'reply_ratio_24h', direction: 'up', horizonHours: 24 },
        }),
      ),
    ];
    const results = await Promise.all(jobs);
    const total = results.reduce((sum, n) => sum + n, 0);
    // Two unique (kpi, horizon) tuples → two rows.
    expect(total).toBe(2);
    expect(tables.lift_measurements.rows.length).toBe(2);
  });
});

describe('insertBaseline clock skew', () => {
  it('baseline_at in the future pushes measure_at further out — row stays pending past current wall clock', async () => {
    const tables: Record<string, Table> = {};
    const db = buildDb(tables);
    // Baseline 1 day ahead of "now"; horizon 24h → measure_at is 2
    // days ahead. A probe at "now" must not pick it up.
    const futureBaseline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const n = await insertBaseline(db, {
      workspaceId: 'ws-1',
      commitSha: 'skew-sha',
      expected: EXPECTED,
      baselineValue: 1,
      baselineAt: futureBaseline,
    });
    expect(n).toBe(1);
    const nowIso = new Date().toISOString();
    const pending = await listPendingMeasurements(db, 'ws-1', nowIso);
    expect(pending.length).toBe(0);
    // After baseline_at + 24h + epsilon, it should be pickable.
    const pickableIso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const later = await listPendingMeasurements(db, 'ws-1', pickableIso);
    expect(later.length).toBe(1);
  });

  it('unparseable baseline_at returns 0 without inserting', async () => {
    const tables: Record<string, Table> = {};
    const db = buildDb(tables);
    const n = await insertBaseline(db, {
      workspaceId: 'ws-1',
      commitSha: 'garbage-sha',
      expected: EXPECTED,
      baselineValue: 1,
      baselineAt: 'not-a-timestamp',
    });
    expect(n).toBe(0);
    expect(tables.lift_measurements?.rows?.length ?? 0).toBe(0);
  });

  it('epoch-zero baseline_at still inserts (no NaN branch)', async () => {
    // Date.parse('1970-01-01T00:00:00.000Z') = 0, which is finite.
    // Historic dates must not trigger the "unparseable" guard.
    const tables: Record<string, Table> = {};
    const db = buildDb(tables);
    const n = await insertBaseline(db, {
      workspaceId: 'ws-1',
      commitSha: 'epoch-sha',
      expected: EXPECTED,
      baselineValue: 1,
      baselineAt: '1970-01-01T00:00:00.000Z',
    });
    expect(n).toBe(1);
    const row = tables.lift_measurements.rows[0];
    expect(row.baseline_at).toBe('1970-01-01T00:00:00.000Z');
    expect(row.measure_at).toBe('1970-01-02T00:00:00.000Z');
  });
});

describe('workspace-id rewrite consolidation', () => {
  // Before the daemon/cloud.ts consolidation pass was extended to
  // lift_measurements, rows inserted under 'local' stayed orphaned
  // after the canonical workspace id flipped to a cloud UUID — the
  // probe (reading under the canonical id) would never see them. This
  // test exercises the post-consolidation shape: after the UPDATE
  // pass runs, the pre-consolidation row is visible under the
  // canonical id and the 'local' sentinel is empty.
  it('rows inserted under "local" are reachable under the canonical id after a consolidation-shaped UPDATE', async () => {
    const tables: Record<string, Table> = {};
    const db = buildDb(tables);
    const baselineAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await insertBaseline(db, {
      workspaceId: 'local',
      commitSha: 'pre-consol-sha',
      expected: EXPECTED,
      baselineValue: 100,
      baselineAt,
    });
    const canonicalWorkspaceId = 'd6080b9b-c900-4b4f-8171-c144cbf7c006';
    // Emulate the daemon/cloud.ts UPDATE that runs during
    // consolidation: rewrite every non-canonical workspace_id to the
    // canonical one. This is the exact statement in cloud.ts
    // (UPDATE lift_measurements SET workspace_id=? WHERE workspace_id!=?).
    for (const row of tables.lift_measurements.rows) {
      if (row.workspace_id !== canonicalWorkspaceId) row.workspace_id = canonicalWorkspaceId;
    }
    const nowIso = new Date().toISOString();
    // Probe now reads under the canonical id and finds the migrated row.
    const pendingUnderCanonical = await listPendingMeasurements(db, canonicalWorkspaceId, nowIso);
    expect(pendingUnderCanonical.length).toBe(1);
    expect(pendingUnderCanonical[0].commit_sha).toBe('pre-consol-sha');
    // 'local' is empty — no orphan left behind.
    const pendingUnderLocal = await listPendingMeasurements(db, 'local', nowIso);
    expect(pendingUnderLocal.length).toBe(0);
  });
});

describe('LiftMeasurementExperiment under pressure', () => {
  it('one unreadable KPI in a batch does not abort the rest — failure lands as unmeasured', async () => {
    // Two pending rows. One is a real registry KPI whose read will
    // succeed against empty tables (outbound_dm_24h → 0). The other
    // names a bogus kpi_id — readKpi returns null → verdict
    // 'unmeasured' — and the batch must still close the good row.
    const baselineAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const measureAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const db = buildDb({
      lift_measurements: {
        rows: [
          {
            id: 'good', workspace_id: 'ws-1', commit_sha: 'sha-good',
            kpi_id: 'outbound_dm_24h', expected_direction: 'up', horizon_hours: 24,
            baseline_value: 0, baseline_at: baselineAt, measure_at: measureAt,
            post_value: null, post_at: null, signed_lift: null, verdict: null,
          },
          {
            id: 'bogus', workspace_id: 'ws-1', commit_sha: 'sha-bogus',
            kpi_id: 'not-a-real-kpi', expected_direction: 'up', horizon_hours: 24,
            baseline_value: 0, baseline_at: baselineAt, measure_at: measureAt,
            post_value: null, post_at: null, signed_lift: null, verdict: null,
          },
        ],
      },
      x_dm_messages: { rows: [] },
    });
    const exp = new LiftMeasurementExperiment();
    const r = await exp.probe(ctxFor(db));
    const ev = r.evidence as LiftMeasurementEvidence;
    expect(ev.closed_this_tick).toBe(2);
    // bogus kpi → unmeasured; good row with zero→zero → flat (count tolerance=1).
    expect(ev.by_verdict.unmeasured).toBe(1);
    expect(ev.by_verdict.flat + ev.by_verdict.moved_right + ev.by_verdict.moved_wrong).toBe(1);
    expect(exp.judge(r, [])).toBe('pass');
  });

  it('enforces the 50-row-per-tick cap (PENDING_BATCH_LIMIT) so a large backlog drains across ticks', async () => {
    const baselineAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const measureAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = Array.from({ length: 100 }, (_v, i) => ({
      id: `m${i}`, workspace_id: 'ws-1', commit_sha: `sha-${i}`,
      kpi_id: 'outbound_dm_24h', expected_direction: 'up', horizon_hours: 24,
      baseline_value: 0, baseline_at: baselineAt, measure_at: measureAt,
      post_value: null, post_at: null, signed_lift: null, verdict: null,
    }));
    const db = buildDb({
      lift_measurements: { rows },
      x_dm_messages: { rows: [] },
    });
    const exp = new LiftMeasurementExperiment();
    const r = await exp.probe(ctxFor(db));
    const ev = r.evidence as LiftMeasurementEvidence;
    // Probe caps at 50 per tick; remaining 50 stay pending for the
    // next tick. The backlog drains at a bounded rate — no single
    // tick budget gets torched by a legacy pile-up.
    expect(ev.closed_this_tick).toBe(50);
    const stillPending = rows.filter((r2) => r2.post_at === null).length;
    // 50 got closed, so 50 remain.
    expect(stillPending).toBe(50);
  });
});
