import { describe, it, expect, vi } from 'vitest';
import { listDistilledInsights } from '../insight-distiller.js';

interface Row {
  id?: string;
  experiment_id: string;
  subject: string;
  verdict: string;
  summary: string;
  evidence: string;
  ran_at: string;
  status: string;
}

interface Baseline {
  experiment_id: string;
  subject: string;
  first_seen_at: string;
  last_seen_at: string;
  sample_count: number;
  tracked_field: string | null;
  running_mean: number | null;
  last_value: number | null;
  consecutive_fails: number;
}

function buildDb(findings: Row[], baselines: Baseline[] = []) {
  function makeBuilder(table: string) {
    const filters: Array<{ col: string; val: unknown }> = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN = 2000;

    const apply = () => {
      let out: unknown[];
      if (table === 'self_findings') {
        out = findings.filter((r) =>
          filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.val),
        ) as unknown[];
      } else if (table === 'self_observation_baselines') {
        out = baselines.filter((r) =>
          filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.val),
        ) as unknown[];
      } else {
        out = [];
      }
      if (orderCol) {
        const key = orderCol;
        out = [...out].sort((a, b) => {
          const av = String((a as Record<string, unknown>)[key] ?? '');
          const bv = String((b as Record<string, unknown>)[key] ?? '');
          return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      return out.slice(0, limitN);
    };

    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, val }); return builder; };
    builder.order = (col: string, opts?: { ascending?: boolean }) => {
      orderCol = col;
      orderAsc = opts?.ascending !== false;
      return builder;
    };
    builder.limit = (n: number) => {
      limitN = n;
      return Promise.resolve({ data: apply(), error: null });
    };
    return builder;
  }

  return { db: { from: vi.fn().mockImplementation((t: string) => makeBuilder(t)) } };
}

function ev(novelty: Record<string, unknown>): string {
  return JSON.stringify({ __novelty: novelty });
}

describe('listDistilledInsights', () => {
  it('ranks higher novelty_score first', async () => {
    const env = buildDb(
      [
        {
          id: 'a',
          experiment_id: 'x-ops-observer',
          subject: 'x-ops:summary',
          verdict: 'warning',
          summary: 'dispatch degraded',
          evidence: ev({ score: 0.7, reason: 'value_z', detail: 'z=2.1' }),
          ran_at: '2026-04-16T06:00:00Z',
          status: 'active',
        },
        {
          id: 'b',
          experiment_id: 'revenue-pipeline-observer',
          subject: 'goals:summary',
          verdict: 'fail',
          summary: 'x posts goal 1/7',
          evidence: ev({ score: 0.95, reason: 'first_seen' }),
          ran_at: '2026-04-16T05:00:00Z',
          status: 'active',
        },
      ],
      [],
    );

    const out = await listDistilledInsights(env.db as never);
    expect(out[0].experiment_id).toBe('revenue-pipeline-observer');
    expect(out[1].experiment_id).toBe('x-ops-observer');
  });

  it('dedupes to latest finding per (experiment_id, subject)', async () => {
    const env = buildDb(
      [
        {
          id: 'new',
          experiment_id: 'x-ops-observer',
          subject: 'x-ops:summary',
          verdict: 'warning',
          summary: 'latest',
          evidence: ev({ score: 0.7, reason: 'value_z' }),
          ran_at: '2026-04-16T06:00:00Z',
          status: 'active',
        },
        {
          id: 'old',
          experiment_id: 'x-ops-observer',
          subject: 'x-ops:summary',
          verdict: 'warning',
          summary: 'earlier',
          evidence: ev({ score: 0.3, reason: 'value_z' }),
          ran_at: '2026-04-16T05:00:00Z',
          status: 'active',
        },
      ],
      [],
    );
    const out = await listDistilledInsights(env.db as never);
    expect(out).toHaveLength(1);
    expect(out[0].latest_finding_id).toBe('new');
    expect(out[0].summary).toBe('latest');
  });

  it('tiebreaks on consecutive_fails when scores are equal', async () => {
    const env = buildDb(
      [
        {
          id: 'a',
          experiment_id: 'e1',
          subject: 's1',
          verdict: 'fail',
          summary: 'a',
          evidence: ev({ score: 0.5, reason: 'repeat_count' }),
          ran_at: '2026-04-16T06:00:00Z',
          status: 'active',
        },
        {
          id: 'b',
          experiment_id: 'e2',
          subject: 's2',
          verdict: 'fail',
          summary: 'b',
          evidence: ev({ score: 0.5, reason: 'repeat_count' }),
          ran_at: '2026-04-16T06:00:00Z',
          status: 'active',
        },
      ],
      [
        {
          experiment_id: 'e1',
          subject: 's1',
          first_seen_at: '2026-04-14T00:00:00Z',
          last_seen_at: '2026-04-16T06:00:00Z',
          sample_count: 100,
          tracked_field: null,
          running_mean: null,
          last_value: null,
          consecutive_fails: 50,
        },
        {
          experiment_id: 'e2',
          subject: 's2',
          first_seen_at: '2026-04-14T00:00:00Z',
          last_seen_at: '2026-04-16T06:00:00Z',
          sample_count: 100,
          tracked_field: null,
          running_mean: null,
          last_value: null,
          consecutive_fails: 10,
        },
      ],
    );
    const out = await listDistilledInsights(env.db as never);
    expect(out.map((r) => r.experiment_id)).toEqual(['e1', 'e2']);
    expect(out[0].consecutive_fails).toBe(50);
  });

  it('filters by min_score', async () => {
    const env = buildDb(
      [
        {
          id: 'a',
          experiment_id: 'e1',
          subject: 's1',
          verdict: 'pass',
          summary: 'a',
          evidence: ev({ score: 0.1, reason: 'normal' }),
          ran_at: '2026-04-16T06:00:00Z',
          status: 'active',
        },
        {
          id: 'b',
          experiment_id: 'e2',
          subject: 's2',
          verdict: 'fail',
          summary: 'b',
          evidence: ev({ score: 0.8, reason: 'first_seen' }),
          ran_at: '2026-04-16T06:00:00Z',
          status: 'active',
        },
      ],
      [],
    );
    const out = await listDistilledInsights(env.db as never, { minScore: 0.5 });
    expect(out.map((r) => r.experiment_id)).toEqual(['e2']);
  });

  it('skips findings without a subject (cannot cluster them)', async () => {
    const env = buildDb(
      [
        {
          id: 'a',
          experiment_id: 'e1',
          subject: '' as string,
          verdict: 'warning',
          summary: 'no subject',
          evidence: ev({ score: 1, reason: 'first_seen' }),
          ran_at: '2026-04-16T06:00:00Z',
          status: 'active',
        },
      ],
      [],
    );
    const out = await listDistilledInsights(env.db as never);
    expect(out).toHaveLength(0);
  });
});
