import { describe, it, expect, vi } from 'vitest';
import { UnforgettableGeneralizationSignalProbeExperiment } from '../experiments/unforgettable-generalization-signal-probe.js';
describe('UnforgettableGeneralizationSignalProbeExperiment', () => {
  it('should pass when metrics show low generalization gap', async () => {
    const experiment = new UnforgettableGeneralizationSignalProbeExperiment();
    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            or: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [
                  { id: 'm1', tags: ['unlearn'], prediction_entropy: 0.5, generalization_gap: 0.05, forgetting_persistence: 100 },
                  { id: 'm2', tags: ['forget'], prediction_entropy: 0.6, generalization_gap: 0.03, forgetting_persistence: 120 }
                ],
                error: null
              })
            })
          })
        })
      })
    };
    const ctx = { db: mockDb } as any;
    const result = await experiment.probe(ctx);
    expect(result.summary).toContain('analyzed 2 models');
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('pass');
  });
  it('should warn when generalization gap is high', async () => {
    const experiment = new UnforgettableGeneralizationSignalProbeExperiment();
    const mockDb = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            or: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [
                  { id: 'm1', tags: ['unlearn'], prediction_entropy: 0.8, generalization_gap: 0.15, forgetting_persistence: 200 }
                ],
                error: null
              })
            })
          })
        })
      })
    };
    const ctx = { db: mockDb } as any;
    const result = await experiment.probe(ctx);
    expect(result.summary).toContain('analyzed 1 models');
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('warning');
  });
});