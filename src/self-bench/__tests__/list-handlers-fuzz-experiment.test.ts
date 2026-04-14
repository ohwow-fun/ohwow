import { describe, it, expect, vi } from 'vitest';
import { ListHandlersFuzzExperiment } from '../experiments/list-handlers-fuzz.js';
import type { Experiment, ExperimentContext, ProbeResult } from '../experiment-types.js';

/**
 * Build a fake ExperimentContext whose `from(table).select('id').eq(…)`
 * chain yields exactly `rowCount` rows for every queried table. Used to
 * drive the fuzz under a known workspace state without mocking every
 * individual table.
 */
function makeCtx(rowCount: number): ExperimentContext {
  const makeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () =>
      Promise.resolve({
        data: Array.from({ length: rowCount }, (_, i) => ({ id: `row-${i}` })),
        error: null,
      });
    return chain;
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { from: vi.fn().mockImplementation(() => makeChain()) } as any,
    workspaceId: 'ws-fuzz',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

describe('ListHandlersFuzzExperiment', () => {
  const exp: Experiment = new ListHandlersFuzzExperiment();

  it('empty workspace produces a clean pass verdict', async () => {
    const ctx = makeCtx(0);
    const result = await exp.probe(ctx);
    const ev = result.evidence as {
      active_count: number;
      latent_count: number;
      clean_count: number;
      total_probes: number;
    };
    expect(ev.active_count).toBe(0);
    expect(ev.latent_count).toBe(0);
    expect(ev.clean_count).toBe(ev.total_probes);
    expect(result.summary).toMatch(/clean/);
    expect(result.subject).toBeNull();
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('populated workspace with high row count stays clean (all probes are unbounded or paginated-with-total)', async () => {
    // After the E4 fixes every bounded probe has returnsTotal=true,
    // so no handler should flag active even with 10k rows. This
    // test pins that invariant — if a new probe lands as bounded-
    // without-total the judge will flip to fail and this test
    // will catch it.
    const ctx = makeCtx(10_000);
    const result = await exp.probe(ctx);
    const ev = result.evidence as { active_count: number; latent_count: number };
    expect(ev.active_count).toBe(0);
    expect(ev.latent_count).toBe(0);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('judge fails on synthetic active finding and warns on synthetic latent finding', () => {
    const fail: ProbeResult = {
      subject: 'list:fake',
      summary: 'synthetic',
      evidence: {
        total_probes: 11,
        active_count: 1,
        latent_count: 0,
        clean_count: 10,
        active_findings: [{ tool: 'fake', table: 'x', total_rows: 100, effective_limit: 20, verdict: 'ACTIVE: …' }],
        latent_findings: [],
      },
    };
    expect(exp.judge(fail, [])).toBe('fail');

    const warn: ProbeResult = {
      subject: 'list:fake2',
      summary: 'synthetic',
      evidence: {
        total_probes: 11,
        active_count: 0,
        latent_count: 1,
        clean_count: 10,
        active_findings: [],
        latent_findings: [{ tool: 'fake2', table: 'y', total_rows: 3, effective_limit: 20, verdict: 'LATENT: …' }],
      },
    };
    expect(exp.judge(warn, [])).toBe('warning');
  });

  it('no intervene method exists (pure observation)', () => {
    expect(exp.intervene).toBeUndefined();
  });
});
