import { describe, it, expect, vi } from 'vitest';
import { RlFineTuningReasoningDriftExperiment } from '../experiments/rl-fine-tuning-reasoning-drift.js';
describe('RlFineTuningReasoningDriftExperiment', () => {
  it('should pass when drift is low and error rate is low', async () => {
    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    };
    const ctx = { db: mockDb } as any;
    const experiment = new RlFineTuningReasoningDriftExperiment();
    const result = await experiment.probe(ctx);
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('pass');
  });
  it('should warn when drift is moderate', async () => {
    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation((n: number) => {
          if (n === 100) {
            return Promise.resolve({ data: [{ task_type: 'reasoning', condition: 'noisy', accuracy: 0.85, latency_ms: 200, error_rate: 0.15, timestamp: '2024-01-01' }], error: null });
          }
          if (n === 50) {
            return Promise.resolve({ data: [{ event_type: 'rl_fine_tuning', timestamp: '2024-01-01' }], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        }),
      }),
    };
    const ctx = { db: mockDb } as any;
    const experiment = new RlFineTuningReasoningDriftExperiment();
    const result = await experiment.probe(ctx);
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('warning');
  });
});