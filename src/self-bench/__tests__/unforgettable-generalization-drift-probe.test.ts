import { describe, it, expect, vi } from 'vitest';
import { UnforgettableGeneralizationDriftProbeExperiment } from '../experiments/unforgettable-generalization-drift-probe.js';
describe('UnforgettableGeneralizationDriftProbeExperiment', () => {
  it('should pass when metrics show low drift and randomness', async () => {
    const experiment = new UnforgettableGeneralizationDriftProbeExperiment();
    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [{ id: '1', timestamp: '2024-01-01', task: 'task1' }], error: null }),
        }),
      }),
    };
    const ctx = { db: mockDb } as any;
    const result = await experiment.probe(ctx);
    expect(result.summary).toContain('unlearning logs: 1');
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('pass');
  });
  it('should warn when drift is high', async () => {
    const experiment = new UnforgettableGeneralizationDriftProbeExperiment();
    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [{ id: '1', randomness_score: 0.6, performance_drift: 0.2 }], error: null }),
        }),
      }),
    };
    const ctx = { db: mockDb } as any;
    const result = await experiment.probe(ctx);
    expect(result.summary).toContain('avg drift: 0.200');
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('warning');
  });
});