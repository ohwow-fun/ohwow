import { describe, it, expect, vi } from 'vitest';
import { RevenuePipelineObserverExperiment } from '../experiments/revenue-pipeline-observer.js';
import type { ExperimentContext } from '../experiment-types.js';

interface Table {
  rows: Record<string, unknown>[];
}

function buildDb(tables: Record<string, Table>) {
  function makeBuilder(name: string) {
    if (!tables[name]) tables[name] = { rows: [] };
    const t = tables[name];
    const filters: Array<{ col: string; val: unknown }> = [];
    const rangeFilters: Array<{ col: string; op: 'gte'; val: unknown }> = [];
    const apply = () => t.rows.filter((r) =>
      filters.every((f) => r[f.col] === f.val) &&
      rangeFilters.every((f) => String(r[f.col]) >= String(f.val)),
    );
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, val }); return builder; };
    builder.gte = (col: string, val: unknown) => { rangeFilters.push({ col, op: 'gte', val }); return builder; };
    builder.order = () => builder;
    builder.limit = () => Promise.resolve({ data: apply(), error: null });
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: apply(), error: null });
    return builder;
  }
  return { from: vi.fn().mockImplementation((n: string) => makeBuilder(n)) };
}

function ctx(db: unknown): ExperimentContext {
  return {
    db: db as never,
    workspaceId: 'ws-1',
    workspaceSlug: 'default',
    engine: {} as never,
    recentFindings: async () => [],
  };
}

describe('RevenuePipelineObserverExperiment', () => {
  it('passes when goals are on pace and leads are growing', async () => {
    // Goal created at start of month, 80% through month, 80% current.
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const total = endOfMonth.getTime() - monthStart.getTime();
    const elapsedFrac = (now.getTime() - monthStart.getTime()) / total;
    const expectedNow = 100 * elapsedFrac; // assuming target=100
    const db = buildDb({
      agent_workforce_goals: {
        rows: [
          {
            id: 'g1',
            workspace_id: 'ws-1',
            title: 'Leads per month',
            target_metric: 'leads',
            target_value: 100,
            current_value: Math.ceil(expectedNow + 5), // ahead of pace
            status: 'active',
            created_at: monthStart.toISOString(),
          },
        ],
      },
      agent_workforce_contacts: {
        rows: [
          { id: 'c1', workspace_id: 'ws-1', contact_type: 'lead', status: 'active', created_at: new Date(Date.now() - 86400000).toISOString() },
          { id: 'c2', workspace_id: 'ws-1', contact_type: 'lead', status: 'active', created_at: new Date(Date.now() - 86400000 * 2).toISOString() },
        ],
      },
      agent_workforce_contact_events: { rows: [] },
      agent_workforce_revenue_entries: { rows: [] },
    });
    const exp = new RevenuePipelineObserverExperiment();
    const res = await exp.probe(ctx(db));
    expect(exp.judge(res, [])).toBe('pass');
  });

  it('fails when a revenue goal is at <=30% of pace', async () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const db = buildDb({
      agent_workforce_goals: {
        rows: [
          {
            id: 'g2',
            workspace_id: 'ws-1',
            title: 'Leads per month',
            target_metric: 'leads',
            target_value: 100,
            current_value: 1, // way behind
            status: 'active',
            created_at: monthStart.toISOString(),
          },
        ],
      },
      agent_workforce_contacts: { rows: [] },
      agent_workforce_contact_events: { rows: [] },
      agent_workforce_revenue_entries: { rows: [] },
    });
    const exp = new RevenuePipelineObserverExperiment();
    const res = await exp.probe(ctx(db));
    const ev = res.evidence as { goal_count_below_fail: number; worst_goal_pace_fraction: number };
    expect(ev.goal_count_below_fail).toBeGreaterThan(0);
    expect(exp.judge(res, [])).toBe('fail');
  });

  it('skips with a friendly summary when workspace is not the GTM slot', async () => {
    const db = buildDb({});
    const exp = new RevenuePipelineObserverExperiment();
    const res = await exp.probe({
      db: db as never,
      workspaceId: 'ws-other',
      workspaceSlug: 'customer-workspace',
      engine: {} as never,
      recentFindings: async () => [],
    });
    // BusinessExperiment.probe() guards by slug — skipped returns pass via judge.
    expect(exp.judge(res, [])).toBe('pass');
    expect(res.evidence.skipped).toBe(true);
  });
});
