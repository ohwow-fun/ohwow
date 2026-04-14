import { describe, it, expect, beforeEach } from 'vitest';
import { ModelHealthExperiment } from '../experiments/model-health.js';
import { _resetAgentModelDemotionCacheForTests } from '../../execution/agent-model-tiers.js';
import type { ExperimentContext, ProbeResult } from '../experiment-types.js';

/**
 * Exercises the ModelHealthExperiment by feeding it fake llm_calls
 * rows and asserting the probe captures the right evidence, the
 * judge escalates correctly based on demoted count vs total, and
 * intervene returns null when no demotion is needed.
 */

function fakeLlmCalls(rows: Array<{ model: string; tool_call_count: number | null }>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => Promise.resolve({ data: rows, error: null }),
  };
  return {
    from: () => chain,
  };
}

function makeCtx(rows: Array<{ model: string; tool_call_count: number | null }>): ExperimentContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    db: fakeLlmCalls(rows) as any,
    workspaceId: 'ws-1',
    engine: {} as any,
    recentFindings: async () => [],
  };
}

describe('ModelHealthExperiment', () => {
  const exp = new ModelHealthExperiment();

  beforeEach(() => {
    _resetAgentModelDemotionCacheForTests();
  });

  it('probes with zero rolling samples and returns empty evidence', async () => {
    const ctx = makeCtx([]);
    const result = await exp.probe(ctx);
    expect(result.evidence.tracked_models).toBe(0);
    expect(result.evidence.demoted_count).toBe(0);
    expect(result.subject).toBeNull();
    expect(result.summary).toContain('no rolling telemetry');
  });

  it('judges zero-sample probe as warning (no signal yet)', async () => {
    const ctx = makeCtx([]);
    const result = await exp.probe(ctx);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('probes a healthy model and returns pass', async () => {
    const ctx = makeCtx(
      Array.from({ length: 12 }, () => ({ model: 'qwen/qwen3.5-35b-a3b', tool_call_count: 1 })),
    );
    const result = await exp.probe(ctx);
    expect(result.evidence.tracked_models).toBe(1);
    expect(result.evidence.demoted_count).toBe(0);
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('probes a broken model, captures demotion in evidence, and judges warning', async () => {
    const ctx = makeCtx(
      Array.from({ length: 12 }, () => ({ model: 'qwen/qwen3.5-9b', tool_call_count: 0 })),
    );
    const result = await exp.probe(ctx);
    expect(result.evidence.demoted_count).toBe(1);
    expect(result.evidence.demoted_models).toContain('qwen/qwen3.5-9b');
    expect(result.subject).toBe('qwen/qwen3.5-9b');
    // Only 1/1 tracked demoted — but "more than half" → 1*2 > 1 → true → fail
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('judges 1-of-3 demoted as warning (minority unhealthy)', async () => {
    const ctx = makeCtx([
      ...Array.from({ length: 12 }, () => ({ model: 'a/good', tool_call_count: 1 })),
      ...Array.from({ length: 12 }, () => ({ model: 'b/good', tool_call_count: 1 })),
      ...Array.from({ length: 12 }, () => ({ model: 'c/bad', tool_call_count: 0 })),
    ]);
    const result = await exp.probe(ctx);
    expect(result.evidence.tracked_models).toBe(3);
    expect(result.evidence.demoted_count).toBe(1);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('judges 2-of-3 demoted as fail (majority unhealthy)', async () => {
    const ctx = makeCtx([
      ...Array.from({ length: 12 }, () => ({ model: 'a/good', tool_call_count: 1 })),
      ...Array.from({ length: 12 }, () => ({ model: 'b/bad', tool_call_count: 0 })),
      ...Array.from({ length: 12 }, () => ({ model: 'c/bad', tool_call_count: 0 })),
    ]);
    const result = await exp.probe(ctx);
    expect(result.evidence.demoted_count).toBe(2);
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('intervene returns null when nothing is demoted', async () => {
    const ctx = makeCtx(
      Array.from({ length: 12 }, () => ({ model: 'a/good', tool_call_count: 1 })),
    );
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('pass', result, ctx);
    expect(intervention).toBeNull();
  });

  it('intervene returns structured details when demotion happened', async () => {
    const ctx = makeCtx(
      Array.from({ length: 12 }, () => ({ model: 'dead/model', tool_call_count: 0 })),
    );
    const result = await exp.probe(ctx);
    const intervention = await exp.intervene!('fail', result, ctx);
    expect(intervention).not.toBeNull();
    expect(intervention!.description).toContain('demoted');
    expect((intervention!.details.demoted_models as string[])).toContain('dead/model');
  });
});
