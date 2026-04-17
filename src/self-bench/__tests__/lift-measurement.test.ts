import { describe, it, expect, vi } from 'vitest';
import { LiftMeasurementExperiment, type LiftMeasurementEvidence } from '../experiments/lift-measurement.js';
import type { ExperimentContext } from '../experiment-types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

// Mirror the chainable mock used by lift-measurements-store.test.ts.
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
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { eqFilters.push({ col, val }); return builder; };
    builder.gte = (col: string, val: unknown) => { gteFilters.push({ col, val }); return builder; };
    builder.lte = (col: string, val: unknown) => { lteFilters.push({ col, val }); return builder; };
    builder.is = (col: string, val: unknown) => { isFilters.push({ col, val }); return builder; };
    builder.order = () => builder;
    builder.limit = () => Promise.resolve({ data: apply(), error: null });
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: apply(), error: null });
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

function ctx(db: DatabaseAdapter): ExperimentContext {
  return {
    db,
    workspaceId: 'ws-1',
    workspaceSlug: 'default',
    engine: {} as never,
    recentFindings: async () => [],
  };
}

describe('LiftMeasurementExperiment', () => {
  it('passes and emits zero-closed evidence when no rows are pending', async () => {
    const db = buildDb({ lift_measurements: { rows: [] } });
    const exp = new LiftMeasurementExperiment();
    const r = await exp.probe(ctx(db));
    const ev = r.evidence as LiftMeasurementEvidence;
    expect(ev.closed_this_tick).toBe(0);
    expect(ev.closed_commits).toEqual([]);
    expect(exp.judge(r, [])).toBe('pass');
  });

  it('closes a pending row and records moved_right when the KPI increased', async () => {
    const db = buildDb({
      lift_measurements: {
        rows: [
          {
            id: 'm1',
            workspace_id: 'ws-1',
            commit_sha: 'sha-a',
            kpi_id: 'outbound_dm_24h',
            expected_direction: 'up',
            horizon_hours: 24,
            baseline_value: 2,
            baseline_at: '2026-04-15T00:00:00.000Z',
            measure_at: '2026-04-16T00:00:00.000Z', // past
            post_value: null,
            post_at: null,
            signed_lift: null,
            verdict: null,
          },
        ],
      },
      // Current KPI reading: 8 outbound DMs in last 24h > 1 tolerance, positive lift
      x_dm_messages: {
        rows: Array.from({ length: 8 }, (_v, i) => ({
          workspace_id: 'ws-1',
          direction: 'outbound',
          observed_at: new Date(Date.now() - (i + 1) * 3600_000).toISOString(),
        })),
      },
    });
    const exp = new LiftMeasurementExperiment();
    const r = await exp.probe(ctx(db));
    const ev = r.evidence as LiftMeasurementEvidence;
    expect(ev.closed_this_tick).toBe(1);
    expect(ev.by_verdict.moved_right).toBe(1);
    expect(ev.closed_commits[0].commit_sha).toBe('sha-a');
    expect(ev.closed_commits[0].rows[0].verdict).toBe('moved_right');
    expect(exp.judge(r, [])).toBe('pass');
  });

  it('fails when at least 3 commits moved the wrong way in one tick', async () => {
    const rows = Array.from({ length: 3 }, (_v, i) => ({
      id: `m${i}`,
      workspace_id: 'ws-1',
      commit_sha: `sha-${i}`,
      kpi_id: 'outbound_dm_24h',
      expected_direction: 'up',
      horizon_hours: 24,
      baseline_value: 20,
      baseline_at: '2026-04-15T00:00:00.000Z',
      measure_at: '2026-04-16T00:00:00.000Z',
      post_value: null,
      post_at: null,
      signed_lift: null,
      verdict: null,
    }));
    // Post value: 0 outbound DMs observed → dropped from 20 to 0, moved_wrong
    const db = buildDb({
      lift_measurements: { rows },
      x_dm_messages: { rows: [] },
    });
    const exp = new LiftMeasurementExperiment();
    const r = await exp.probe(ctx(db));
    const ev = r.evidence as LiftMeasurementEvidence;
    expect(ev.by_verdict.moved_wrong).toBe(3);
    expect(exp.judge(r, [])).toBe('fail');
  });

  it('groups multiple KPIs from the same commit into one closed_commits entry', async () => {
    const db = buildDb({
      lift_measurements: {
        rows: [
          {
            id: 'm1', workspace_id: 'ws-1', commit_sha: 'sha-x',
            kpi_id: 'outbound_dm_24h', expected_direction: 'up', horizon_hours: 24,
            baseline_value: 0, baseline_at: '2026-04-15T00:00:00.000Z',
            measure_at: '2026-04-16T00:00:00.000Z',
            post_value: null, post_at: null, signed_lift: null, verdict: null,
          },
          {
            id: 'm2', workspace_id: 'ws-1', commit_sha: 'sha-x',
            kpi_id: 'inbound_dm_24h', expected_direction: 'up', horizon_hours: 24,
            baseline_value: 0, baseline_at: '2026-04-15T00:00:00.000Z',
            measure_at: '2026-04-16T00:00:00.000Z',
            post_value: null, post_at: null, signed_lift: null, verdict: null,
          },
        ],
      },
      x_dm_messages: { rows: [] },
    });
    const exp = new LiftMeasurementExperiment();
    const r = await exp.probe(ctx(db));
    const ev = r.evidence as LiftMeasurementEvidence;
    expect(ev.closed_this_tick).toBe(2);
    expect(ev.closed_commits.length).toBe(1);
    expect(ev.closed_commits[0].rows.length).toBe(2);
  });
});
