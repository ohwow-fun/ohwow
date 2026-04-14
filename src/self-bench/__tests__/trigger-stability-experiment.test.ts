import { describe, it, expect, vi } from 'vitest';
import { TriggerStabilityExperiment } from '../experiments/trigger-stability.js';
import { TRIGGER_STUCK_THRESHOLD } from '../../triggers/trigger-watchdog.js';
import type { Experiment, ExperimentContext } from '../experiment-types.js';

function makeCtx(rows: Array<Record<string, unknown>>): ExperimentContext {
  // Only the .from('local_triggers').select(...).gte(...).order() path matters.
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.gte = () => chain;
  chain.order = () => Promise.resolve({ data: rows, error: null });
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { from: vi.fn().mockReturnValue(chain) } as any,
    workspaceId: 'ws-1',
    engine: {} as any,
    recentFindings: async () => [],
  };
}

describe('TriggerStabilityExperiment', () => {
  // Typed as Experiment so the optional intervene field is visible to tests.
  const exp: Experiment = new TriggerStabilityExperiment();

  it('passes when no triggers are failing', async () => {
    const ctx = makeCtx([]);
    const result = await exp.probe(ctx);
    expect(result.evidence.stuck_count).toBe(0);
    expect(result.evidence.warning_count).toBe(0);
    expect(result.summary).toBe('all triggers healthy');
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('judges 1-2 consecutive failures as warning (below stuck threshold)', async () => {
    const ctx = makeCtx([
      { id: 't1', name: 'shaky', consecutive_failures: 2, last_succeeded_at: '2026-04-13', last_fired_at: '2026-04-14', enabled: 1 },
    ]);
    const result = await exp.probe(ctx);
    expect(result.evidence.warning_count).toBe(1);
    expect(result.evidence.stuck_count).toBe(0);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('judges at-or-above stuck threshold as fail', async () => {
    const ctx = makeCtx([
      { id: 't1', name: 'dead', consecutive_failures: TRIGGER_STUCK_THRESHOLD, last_succeeded_at: null, last_fired_at: '2026-04-14', enabled: 1 },
    ]);
    const result = await exp.probe(ctx);
    expect(result.evidence.stuck_count).toBe(1);
    expect(result.evidence.threshold).toBe(TRIGGER_STUCK_THRESHOLD);
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('judges fails even when warnings also exist', async () => {
    const ctx = makeCtx([
      { id: 't1', name: 'dead', consecutive_failures: 5, last_succeeded_at: null, last_fired_at: '2026-04-14', enabled: 1 },
      { id: 't2', name: 'shaky', consecutive_failures: 1, last_succeeded_at: '2026-04-13', last_fired_at: '2026-04-14', enabled: 1 },
    ]);
    const result = await exp.probe(ctx);
    expect(result.evidence.stuck_count).toBe(1);
    expect(result.evidence.warning_count).toBe(1);
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('subject is set to the worst offender id', async () => {
    const ctx = makeCtx([
      { id: 'trig-worst', name: 'dead', consecutive_failures: 7, last_succeeded_at: null, last_fired_at: '2026-04-14', enabled: 1 },
      { id: 'trig-less', name: 'shaky', consecutive_failures: 2, last_succeeded_at: null, last_fired_at: '2026-04-14', enabled: 1 },
    ]);
    const result = await exp.probe(ctx);
    expect(result.subject).toBe('trigger:trig-worst');
  });

  it('no intervene method exists (pure observation)', () => {
    expect(exp.intervene).toBeUndefined();
  });
});
