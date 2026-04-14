import { describe, it, expect, vi } from 'vitest';
import { LedgerHealthExperiment } from '../experiments/ledger-health.js';
import type { Experiment, ExperimentContext } from '../experiment-types.js';

/**
 * DB stub that returns a fixed list of self_findings rows. The
 * listFindings call uses .from().select().eq().order().limit().
 */
function buildDb(rows: Array<Record<string, unknown>>) {
  function makeBuilder() {
    const filters: Array<{ col: string; val: unknown }> = [];
    let orderDesc = true;
    let limitN: number | null = null;
    const apply = () => {
      let out = rows.filter((r) => filters.every((f) => r[f.col] === f.val));
      out = [...out].sort((a, b) => {
        const av = String(a.ran_at ?? '');
        const bv = String(b.ran_at ?? '');
        return orderDesc ? bv.localeCompare(av) : av.localeCompare(bv);
      });
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (col: string, val: unknown) => { filters.push({ col, val }); return builder; };
    builder.order = (_col: string, opts?: { ascending?: boolean }) => {
      orderDesc = opts?.ascending === false ? true : opts?.ascending === true ? false : true;
      return builder;
    };
    builder.limit = (n: number) => {
      limitN = n;
      return Promise.resolve({ data: apply(), error: null });
    };
    return builder;
  }
  return { from: vi.fn().mockImplementation(() => makeBuilder()) };
}

function makeCtx(rows: Array<Record<string, unknown>>): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: buildDb(rows) as any,
    workspaceId: 'ws-1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

function recentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'f1', experiment_id: 'model-health', category: 'model_health', subject: null,
    hypothesis: null, verdict: 'pass', summary: 'all good', evidence: '{}',
    intervention_applied: null, ran_at: new Date().toISOString(),
    duration_ms: 5, status: 'active', superseded_by: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('LedgerHealthExperiment', () => {
  const exp: Experiment = new LedgerHealthExperiment();

  it('probe returns zero experiments when the ledger is empty', async () => {
    const ctx = makeCtx([]);
    const result = await exp.probe(ctx);
    expect((result.evidence as { experiments: unknown[] }).experiments).toHaveLength(0);
    expect((result.evidence as { stalled_count: number }).stalled_count).toBe(0);
    expect(result.summary).toContain('runner may not be started yet');
  });

  it('judges empty ledger as warning', async () => {
    const ctx = makeCtx([]);
    const result = await exp.probe(ctx);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('groups findings by experiment_id and reports healthy experiments', async () => {
    const ctx = makeCtx([
      recentRow({ id: 'a1', experiment_id: 'model-health', verdict: 'pass' }),
      recentRow({ id: 'a2', experiment_id: 'model-health', verdict: 'pass' }),
      recentRow({ id: 'b1', experiment_id: 'trigger-stability', verdict: 'pass' }),
    ]);
    const result = await exp.probe(ctx);
    const ev = result.evidence as { experiments: Array<{ experiment_id: string; recent_runs: number; stalled: boolean }> };
    expect(ev.experiments).toHaveLength(2);
    const modelHealth = ev.experiments.find((e) => e.experiment_id === 'model-health');
    const triggerStability = ev.experiments.find((e) => e.experiment_id === 'trigger-stability');
    expect(modelHealth?.recent_runs).toBe(2);
    expect(triggerStability?.recent_runs).toBe(1);
    expect(modelHealth?.stalled).toBe(false);
  });

  it('judges all-healthy ledger as pass', async () => {
    const ctx = makeCtx([
      recentRow({ id: 'a1', experiment_id: 'model-health', verdict: 'pass' }),
    ]);
    const result = await exp.probe(ctx);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('detects stalled experiments based on 45m staleness threshold', async () => {
    const staleAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const ctx = makeCtx([
      recentRow({ id: 'a1', experiment_id: 'stalled-one', verdict: 'pass', ran_at: staleAt }),
      recentRow({ id: 'b1', experiment_id: 'healthy-one', verdict: 'pass' }),
    ]);
    const result = await exp.probe(ctx);
    const ev = result.evidence as { stalled_count: number; experiments: Array<{ experiment_id: string; stalled: boolean }> };
    expect(ev.stalled_count).toBe(1);
    expect(ev.experiments.find((e) => e.experiment_id === 'stalled-one')?.stalled).toBe(true);
    expect(ev.experiments.find((e) => e.experiment_id === 'healthy-one')?.stalled).toBe(false);
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('detects erroring experiments when error_rate >= 50% with 2+ runs', async () => {
    const ctx = makeCtx([
      recentRow({ id: 'a1', experiment_id: 'buggy-probe', verdict: 'error' }),
      recentRow({ id: 'a2', experiment_id: 'buggy-probe', verdict: 'error' }),
      recentRow({ id: 'a3', experiment_id: 'buggy-probe', verdict: 'pass' }),
    ]);
    const result = await exp.probe(ctx);
    const ev = result.evidence as { erroring_count: number; experiments: Array<{ experiment_id: string; error_rate: number }> };
    expect(ev.erroring_count).toBe(1);
    const buggy = ev.experiments.find((e) => e.experiment_id === 'buggy-probe');
    expect(buggy?.error_rate).toBeCloseTo(2 / 3);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('does NOT count its own findings (avoids self-reference loop)', async () => {
    const ctx = makeCtx([
      recentRow({ id: 'a1', experiment_id: 'ledger-health', verdict: 'pass' }),
      recentRow({ id: 'b1', experiment_id: 'model-health', verdict: 'pass' }),
    ]);
    const result = await exp.probe(ctx);
    const ev = result.evidence as { experiments: Array<{ experiment_id: string }> };
    expect(ev.experiments).toHaveLength(1);
    expect(ev.experiments[0].experiment_id).toBe('model-health');
  });

  it('no intervene method (pure observation)', () => {
    expect(exp.intervene).toBeUndefined();
  });
});
