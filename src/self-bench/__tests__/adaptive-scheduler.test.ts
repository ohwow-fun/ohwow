import { describe, it, expect, vi } from 'vitest';
import {
  AdaptiveSchedulerExperiment,
  stretchMultiplierForStreak,
} from '../experiments/adaptive-scheduler.js';
import type {
  Experiment,
  ExperimentContext,
  ExperimentScheduler,
  Finding,
} from '../experiment-types.js';

/**
 * Fake scheduler that records every setNextRunAt call for assertions.
 */
function makeScheduler(peers: Array<{
  id: string;
  name?: string;
  cadence?: { everyMs: number };
  nextRunAt?: number;
}>): ExperimentScheduler & { calls: Array<{ id: string; ts: number }> } {
  const calls: Array<{ id: string; ts: number }> = [];
  return {
    setNextRunAt: (id, ts) => { calls.push({ id, ts }); },
    getRegisteredExperimentInfo: () => peers.map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      category: 'other' as const,
      cadence: p.cadence ?? { everyMs: 10 * 60 * 1000 },
      nextRunAt: p.nextRunAt ?? Date.now(),
    })),
    calls,
  };
}

/**
 * Build a Finding with minimal fields set — just enough to drive the
 * scheduler's history inspection logic.
 */
function finding(overrides: Partial<Finding> & Pick<Finding, 'experimentId' | 'verdict'>): Finding {
  return {
    id: 'f-' + Math.random().toString(36).slice(2),
    experimentId: overrides.experimentId,
    category: 'other',
    subject: null,
    hypothesis: null,
    verdict: overrides.verdict,
    summary: '',
    evidence: {},
    interventionApplied: overrides.interventionApplied ?? null,
    ranAt: overrides.ranAt ?? new Date().toISOString(),
    durationMs: 0,
    status: 'active',
    supersededBy: null,
    createdAt: new Date().toISOString(),
  };
}

function makeCtx(
  scheduler: ExperimentScheduler,
  historyByExperiment: Record<string, Finding[]>,
): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: {} as any,
    workspaceId: 'ws-1',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async (experimentId: string) =>
      historyByExperiment[experimentId] ?? [],
    scheduler,
  };
}

describe('stretchMultiplierForStreak', () => {
  it('returns 1.0 below the threshold', () => {
    expect(stretchMultiplierForStreak(0)).toBe(1.0);
    expect(stretchMultiplierForStreak(5)).toBe(1.0);
    expect(stretchMultiplierForStreak(9)).toBe(1.0);
  });
  it('returns 1.5 for streaks 10-19', () => {
    expect(stretchMultiplierForStreak(10)).toBe(1.5);
    expect(stretchMultiplierForStreak(19)).toBe(1.5);
  });
  it('returns 2.0 for streaks 20-49', () => {
    expect(stretchMultiplierForStreak(20)).toBe(2.0);
    expect(stretchMultiplierForStreak(49)).toBe(2.0);
  });
  it('returns 3.0 for streaks 50-99', () => {
    expect(stretchMultiplierForStreak(50)).toBe(3.0);
    expect(stretchMultiplierForStreak(99)).toBe(3.0);
  });
  it('caps at 4.0 for very long streaks', () => {
    expect(stretchMultiplierForStreak(100)).toBe(4.0);
    expect(stretchMultiplierForStreak(500)).toBe(4.0);
    expect(stretchMultiplierForStreak(10_000)).toBe(4.0);
  });
});

describe('AdaptiveSchedulerExperiment', () => {
  const exp: Experiment = new AdaptiveSchedulerExperiment();

  it('no-ops when there is no scheduler in context', async () => {
    const ctx: ExperimentContext = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      workspaceId: 'ws-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engine: {} as any,
      recentFindings: async () => [],
      // no scheduler
    };
    const result = await exp.probe(ctx);
    const ev = result.evidence as { inspected_count: number; adjusted_count: number };
    expect(ev.inspected_count).toBe(0);
    expect(ev.adjusted_count).toBe(0);
  });

  it('skips its own id when iterating peers', async () => {
    const scheduler = makeScheduler([
      { id: 'adaptive-scheduler' }, // self
      { id: 'peer-a' },
    ]);
    const ctx = makeCtx(scheduler, {
      'peer-a': Array.from({ length: 15 }, () => finding({ experimentId: 'peer-a', verdict: 'pass' })),
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { inspected_count: number; adjustments: Array<{ experiment_id: string }> };
    expect(ev.inspected_count).toBe(1); // adaptive-scheduler filtered out
    expect(ev.adjustments).toHaveLength(1);
    expect(ev.adjustments[0].experiment_id).toBe('peer-a');
  });

  it('stretches a peer with 10+ consecutive pass findings', async () => {
    const scheduler = makeScheduler([
      { id: 'healthy', cadence: { everyMs: 10 * 60 * 1000 } },
    ]);
    const ctx = makeCtx(scheduler, {
      'healthy': Array.from({ length: 15 }, () => finding({ experimentId: 'healthy', verdict: 'pass' })),
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { stretched_count: number; pulled_in_count: number; adjustments: Array<{ rule: string; multiplier?: number; streak?: number }> };
    expect(ev.stretched_count).toBe(1);
    expect(ev.pulled_in_count).toBe(0);
    expect(ev.adjustments[0].rule).toBe('pass_streak_stretch');
    expect(ev.adjustments[0].streak).toBe(15);
    expect(ev.adjustments[0].multiplier).toBe(1.5);
  });

  it('does NOT stretch when streak is below threshold', async () => {
    const scheduler = makeScheduler([
      { id: 'new', cadence: { everyMs: 10 * 60 * 1000 } },
    ]);
    const ctx = makeCtx(scheduler, {
      'new': Array.from({ length: 5 }, () => finding({ experimentId: 'new', verdict: 'pass' })),
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { adjustments: unknown[] };
    expect(ev.adjustments).toHaveLength(0);
  });

  it('pulls in a peer with any recent fail finding', async () => {
    const scheduler = makeScheduler([
      { id: 'broken' },
    ]);
    const ctx = makeCtx(scheduler, {
      'broken': [
        finding({ experimentId: 'broken', verdict: 'fail' }),
        finding({ experimentId: 'broken', verdict: 'pass' }),
      ],
    });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { pulled_in_count: number; stretched_count: number; adjustments: Array<{ rule: string; recent_fail_count?: number }> };
    expect(ev.pulled_in_count).toBe(1);
    expect(ev.stretched_count).toBe(0);
    expect(ev.adjustments[0].rule).toBe('failure_pull_in');
    expect(ev.adjustments[0].recent_fail_count).toBe(1);
  });

  it('failure rule takes precedence over stretch rule', async () => {
    const scheduler = makeScheduler([
      { id: 'mixed' },
    ]);
    // 1 fail at position 0, then 50 passes — should pull in, not stretch
    const history: Finding[] = [
      finding({ experimentId: 'mixed', verdict: 'fail' }),
      ...Array.from({ length: 50 }, () => finding({ experimentId: 'mixed', verdict: 'pass' })),
    ];
    const ctx = makeCtx(scheduler, { 'mixed': history });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { pulled_in_count: number; stretched_count: number };
    expect(ev.pulled_in_count).toBe(1);
    expect(ev.stretched_count).toBe(0);
  });

  it('interventions on a pass run break the streak (no stretch)', async () => {
    const scheduler = makeScheduler([
      { id: 'active' },
    ]);
    // 5 pass findings — then an intervention on one of them
    const history: Finding[] = [
      finding({ experimentId: 'active', verdict: 'pass' }),
      finding({ experimentId: 'active', verdict: 'pass', interventionApplied: { description: 'did a thing', details: {} } }),
      ...Array.from({ length: 20 }, () => finding({ experimentId: 'active', verdict: 'pass' })),
    ];
    const ctx = makeCtx(scheduler, { 'active': history });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { adjustments: Array<{ streak?: number }> };
    // streak counts to the intervention row, then stops.
    if (ev.adjustments.length > 0) {
      expect(ev.adjustments[0].streak).toBeLessThan(10);
    } else {
      // Also acceptable: no adjustment because streak < threshold.
      expect(ev.adjustments).toHaveLength(0);
    }
  });

  it('skips peers with no finding history', async () => {
    const scheduler = makeScheduler([
      { id: 'never-ran' },
    ]);
    const ctx = makeCtx(scheduler, { 'never-ran': [] });
    const result = await exp.probe(ctx);
    const ev = result.evidence as { adjustments: unknown[] };
    expect(ev.adjustments).toHaveLength(0);
  });

  it('applies adjustments in intervene() not probe()', async () => {
    const scheduler = makeScheduler([
      { id: 'healthy', cadence: { everyMs: 10 * 60 * 1000 } },
    ]);
    const ctx = makeCtx(scheduler, {
      'healthy': Array.from({ length: 15 }, () => finding({ experimentId: 'healthy', verdict: 'pass' })),
    });
    const result = await exp.probe(ctx);
    // Probe should compute adjustments but NOT have called setNextRunAt.
    expect((scheduler as unknown as { calls: unknown[] }).calls).toHaveLength(0);

    // Intervene applies them.
    await exp.intervene!('pass', result, ctx);
    const calls = (scheduler as unknown as { calls: Array<{ id: string }> }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('healthy');
  });

  it('judge returns pass on healthy inspection', async () => {
    const scheduler = makeScheduler([{ id: 'a' }]);
    const ctx = makeCtx(scheduler, { 'a': [finding({ experimentId: 'a', verdict: 'pass' })] });
    const result = await exp.probe(ctx);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('judge returns warning when there are no peers to inspect', async () => {
    const scheduler = makeScheduler([]);
    const ctx = makeCtx(scheduler, {});
    const result = await exp.probe(ctx);
    expect(exp.judge(result, [])).toBe('warning');
  });
});
