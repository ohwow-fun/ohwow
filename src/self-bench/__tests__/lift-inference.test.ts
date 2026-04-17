import { describe, it, expect, vi } from 'vitest';
import {
  buildLiftBaselineRecorder,
  inferExpectedLifts,
  LIFT_HEURISTICS,
} from '../lift-inference.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

describe('inferExpectedLifts', () => {
  it('returns [] when no file matches any heuristic', () => {
    expect(inferExpectedLifts([])).toEqual([]);
    expect(inferExpectedLifts(['src/lib/format-duration.ts'])).toEqual([]);
    expect(inferExpectedLifts(['src/web/src/pages/Agents.tsx'])).toEqual([]);
    expect(inferExpectedLifts(['AUTONOMY_ROADMAP.md'])).toEqual([]);
  });

  it('matches outreach-policy.ts and returns its KPI lifts', () => {
    const lifts = inferExpectedLifts(['src/lib/outreach-policy.ts']);
    expect(lifts.length).toBeGreaterThan(0);
    const ids = lifts.map((l) => l.kpiId);
    expect(ids).toContain('reply_ratio_24h');
    expect(ids).toContain('qualified_events_24h');
    for (const l of lifts) {
      expect(l.direction).toBe('up');
      expect(l.horizonHours).toBeGreaterThan(0);
    }
  });

  it('emits a 1h horizon on reply_ratio_24h for outreach patches (fast triangulation)', () => {
    const lifts = inferExpectedLifts(['src/lib/outreach-policy.ts']);
    const horizons = lifts
      .filter((l) => l.kpiId === 'reply_ratio_24h')
      .map((l) => l.horizonHours)
      .sort((a, b) => a - b);
    expect(horizons).toEqual([1, 24]);
  });

  it('emits a 1h horizon on qualified_events_24h for qualifier-pipeline patches', () => {
    const lifts = inferExpectedLifts(['scripts/x-experiments/x-authors-to-crm.mjs']);
    const qualifiedHorizons = lifts
      .filter((l) => l.kpiId === 'qualified_events_24h')
      .map((l) => l.horizonHours)
      .sort((a, b) => a - b);
    expect(qualifiedHorizons).toEqual([1, 168]);
    // active_leads still only 168h — too slow to measure at 1h.
    const leadsHorizons = lifts
      .filter((l) => l.kpiId === 'active_leads')
      .map((l) => l.horizonHours);
    expect(leadsHorizons).toEqual([168]);
  });

  it('matches outreach-thermostat.ts under the same heuristic as outreach-policy.ts', () => {
    const policy = inferExpectedLifts(['src/lib/outreach-policy.ts']);
    const thermostat = inferExpectedLifts(['src/self-bench/experiments/outreach-thermostat.ts']);
    expect(thermostat).toEqual(policy);
  });

  it('matches x-authors-to-crm.mjs with leads + qualified horizons', () => {
    const lifts = inferExpectedLifts(['scripts/x-experiments/x-authors-to-crm.mjs']);
    const ids = lifts.map((l) => l.kpiId);
    expect(ids).toContain('active_leads');
    expect(ids).toContain('qualified_events_24h');
  });

  it('first-matcher-wins — picks up to one heuristic per commit', () => {
    // Both files match a different heuristic; first listed wins.
    const lifts = inferExpectedLifts([
      'src/lib/outreach-policy.ts',
      'scripts/x-experiments/x-authors-to-crm.mjs',
    ]);
    const ids = lifts.map((l) => l.kpiId);
    // Outreach-policy heuristic comes first in LIFT_HEURISTICS.
    expect(ids).toContain('reply_ratio_24h');
    // Authors-heuristic-only KPI should NOT appear.
    expect(ids).not.toContain('active_leads');
  });

  it('normalizes backslashes so Windows-style paths match', () => {
    const lifts = inferExpectedLifts(['src\\lib\\outreach-policy.ts']);
    expect(lifts.length).toBeGreaterThan(0);
  });

  it('has no duplicated (kpi, direction, horizon) triples within a single heuristic', () => {
    for (const h of LIFT_HEURISTICS) {
      const keys = h.lifts.map((l) => `${l.kpiId}|${l.direction}|${l.horizonHours}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('buildLiftBaselineRecorder', () => {
  it('reads the baseline KPI via the registry and inserts a row', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const db = buildFakeDb(inserts, /* revenueRows */ [
      { workspace_id: 'ws-1', amount_cents: 1500, created_at: new Date().toISOString(), month: 4, year: 2026 },
    ]);
    const recorder = buildLiftBaselineRecorder(db, 'ws-1');
    await recorder({
      commitSha: 'abc',
      expected: { kpiId: 'revenue_cents_24h', direction: 'up', horizonHours: 24 },
      baselineAt: '2026-04-16T00:00:00.000Z',
      sourceExperimentId: 'patch-author',
    });
    expect(inserts.length).toBe(1);
    const row = inserts[0];
    expect(row.commit_sha).toBe('abc');
    expect(row.kpi_id).toBe('revenue_cents_24h');
    expect(row.baseline_value).toBe(1500);
    expect(row.source_experiment_id).toBe('patch-author');
  });

  it('still inserts a row with null baseline_value when the KPI read fails', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const throwingDb: DatabaseAdapter = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'lift_measurements') {
          return {
            insert: (v: Record<string, unknown>) => {
              inserts.push(v);
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        // Every other table throws — emulates a broken KPI read.
        throw new Error('db offline');
      }),
    } as unknown as DatabaseAdapter;
    const recorder = buildLiftBaselineRecorder(throwingDb, 'ws-1');
    await recorder({
      commitSha: 'abc',
      expected: { kpiId: 'revenue_cents_24h', direction: 'up', horizonHours: 24 },
      baselineAt: '2026-04-16T00:00:00.000Z',
      sourceExperimentId: 'patch-author',
    });
    expect(inserts.length).toBe(1);
    expect(inserts[0].baseline_value).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Minimal db double — supports .from(X).select.eq.gte.limit + .from('lift_...').insert
// -----------------------------------------------------------------------------
function buildFakeDb(
  insertsOut: Array<Record<string, unknown>>,
  revenueRows: Record<string, unknown>[],
): DatabaseAdapter {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'lift_measurements') {
        return {
          insert: (values: Record<string, unknown>) => {
            insertsOut.push(values);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === 'agent_workforce_revenue_entries') {
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.eq = () => builder;
        builder.gte = () => builder;
        builder.limit = () => Promise.resolve({ data: revenueRows, error: null });
        return builder;
      }
      if (table === 'self_findings') {
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.eq = () => builder;
        builder.order = () => builder;
        builder.limit = () => Promise.resolve({ data: [], error: null });
        return builder;
      }
      // Any other table → empty
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.gte = () => builder;
      builder.limit = () => Promise.resolve({ data: [], error: null });
      return builder;
    }),
  } as unknown as DatabaseAdapter;
}
