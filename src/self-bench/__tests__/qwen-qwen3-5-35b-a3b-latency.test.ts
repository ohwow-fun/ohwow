import { describe, it, expect, vi } from 'vitest';
import { QwenQwen3535bA3bLatencyExperiment } from '../experiments/qwen-qwen3-5-35b-a3b-latency.js';
import type { ExperimentContext, ProbeResult } from '../experiment-types.js';

function fakeDb(rows: Array<{ latency_ms: number }>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: () => chain };
}

function makeCtx(rows: Array<{ latency_ms: number }>): ExperimentContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: fakeDb(rows) as any,
    workspaceId: 'ws-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: {} as any,
    recentFindings: async () => [],
  };
}

describe('QwenQwen3535bA3bLatencyExperiment (auto-generated)', () => {
  const exp = new QwenQwen3535bA3bLatencyExperiment();

  it('returns warning when samples < min_samples', async () => {
    const rows = Array.from({ length: 7 }, () => ({ latency_ms: 100 }));
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('returns pass when p50 is below warn threshold', async () => {
    const rows = Array.from({ length: 8 }, () => ({ latency_ms: 4091 }));
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('returns warning when p50 crosses warn threshold', async () => {
    const rows = Array.from({ length: 8 }, () => ({ latency_ms: 8183 }));
    const result = await exp.probe(makeCtx(rows));
    const ev = result.evidence as { p50_latency_ms: number };
    expect(ev.p50_latency_ms).toBeGreaterThanOrEqual(8182);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('returns fail when p50 crosses fail threshold', async () => {
    const rows = Array.from({ length: 8 }, () => ({ latency_ms: 8782 }));
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('evidence exposes model + thresholds for operator audit', async () => {
    const rows = [{ latency_ms: 50 }];
    const result = await exp.probe(makeCtx(rows));
    const ev = result.evidence as { model: string; warn_threshold_ms: number; fail_threshold_ms: number };
    expect(ev.model).toBe('qwen/qwen3.5-35b-a3b');
    expect(ev.warn_threshold_ms).toBe(8182);
    expect(ev.fail_threshold_ms).toBe(8682);
  });
});
