import { describe, it, expect, vi } from 'vitest';
import { XiaomiMimoV2FlashLatencyExperiment } from '../experiments/xiaomi-mimo-v2-flash-latency.js';
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

describe('XiaomiMimoV2FlashLatencyExperiment (auto-generated)', () => {
  const exp = new XiaomiMimoV2FlashLatencyExperiment();

  it('returns warning when samples < min_samples', async () => {
    const rows = Array.from({ length: 6 }, () => ({ latency_ms: 100 }));
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('returns pass when p50 is below warn threshold', async () => {
    const rows = Array.from({ length: 7 }, () => ({ latency_ms: 6349 }));
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('pass');
  });

  it('returns warning when p50 crosses warn threshold', async () => {
    const rows = Array.from({ length: 7 }, () => ({ latency_ms: 12700 }));
    const result = await exp.probe(makeCtx(rows));
    const ev = result.evidence as { p50_latency_ms: number };
    expect(ev.p50_latency_ms).toBeGreaterThanOrEqual(12699);
    expect(exp.judge(result, [])).toBe('warning');
  });

  it('returns fail when p50 crosses fail threshold', async () => {
    const rows = Array.from({ length: 7 }, () => ({ latency_ms: 13299 }));
    const result = await exp.probe(makeCtx(rows));
    expect(exp.judge(result, [])).toBe('fail');
  });

  it('evidence exposes model + thresholds for operator audit', async () => {
    const rows = [{ latency_ms: 50 }];
    const result = await exp.probe(makeCtx(rows));
    const ev = result.evidence as { model: string; warn_threshold_ms: number; fail_threshold_ms: number };
    expect(ev.model).toBe('xiaomi/mimo-v2-flash');
    expect(ev.warn_threshold_ms).toBe(12699);
    expect(ev.fail_threshold_ms).toBe(13199);
  });
});
