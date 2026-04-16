import { describe, it, expect, vi } from 'vitest';
import { UnforgettableGeneralizationSignalExperiment } from '../experiments/unforgettable-generalization-signal.js';
describe('UnforgettableGeneralizationSignalExperiment', () => {
  it('should pass when average consistency is low', async () => {
    const experiment = new UnforgettableGeneralizationSignalExperiment();
    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [{ task_id: 't1', prediction_consistency: 0.5 }], error: null }),
        }),
      }),
    };
    const ctx = { db: mockDb } as any;
    const result = await experiment.probe(ctx);
    expect(result.subject).toContain('avg_consistency_0.500');
    expect(result.evidence.avgConsistency).toBe(0.5);
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('pass');
  });
  it('should warn when average consistency is high', async () => {
    const experiment = new UnforgettableGeneralizationSignalExperiment();
    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [{ task_id: 't1', prediction_consistency: 0.9 }], error: null }),
        }),
      }),
    };
    const ctx = { db: mockDb } as any;
    const result = await experiment.probe(ctx);
    expect(result.subject).toContain('avg_consistency_0.900');
    expect(result.evidence.avgConsistency).toBe(0.9);
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('warning');
  });
});