import { describe, it, expect, vi } from 'vitest';
import { ReasoningAlignmentDriftUnderRlFineTuningExperiment } from '../experiments/reasoning-alignment-drift-under-rl-fine-tuning.js';
describe('ReasoningAlignmentDriftUnderRlFineTuningExperiment', () => {
  const createMockCtx = () => {
    const mockDb: any = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    return { db: mockDb };
  };
  it('should pass when metrics are within baseline', async () => {
    const ctx = createMockCtx();
    ctx.db.limit.mockResolvedValueOnce({
      data: [
        { id: '1', timestamp: Date.now(), coherence_score: 0.85, error_rate: 0.1, token_usage: 800 },
        { id: '2', timestamp: Date.now(), coherence_score: 0.82, error_rate: 0.15, token_usage: 900 },
      ],
      error: null,
    });
    ctx.db.limit.mockResolvedValueOnce({
      data: [
        { id: 't1', inference_id: '1', step_consistency: 0.75 },
        { id: 't2', inference_id: '2', step_consistency: 0.72 },
      ],
      error: null,
    });
    const experiment = new ReasoningAlignmentDriftUnderRlFineTuningExperiment();
    const result = await experiment.probe(ctx as any);
    expect(result.subject).toContain('coherence=0.835');
    expect(result.evidence).toHaveProperty('avgCoherence');
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('pass');
  });
  it('should warn when coherence is below baseline', async () => {
    const ctx = createMockCtx();
    ctx.db.limit.mockResolvedValueOnce({
      data: [
        { id: '1', timestamp: Date.now(), coherence_score: 0.7, error_rate: 0.1, token_usage: 800 },
        { id: '2', timestamp: Date.now(), coherence_score: 0.65, error_rate: 0.15, token_usage: 900 },
      ],
      error: null,
    });
    ctx.db.limit.mockResolvedValueOnce({
      data: [
        { id: 't1', inference_id: '1', step_consistency: 0.75 },
        { id: 't2', inference_id: '2', step_consistency: 0.72 },
      ],
      error: null,
    });
    const experiment = new ReasoningAlignmentDriftUnderRlFineTuningExperiment();
    const result = await experiment.probe(ctx as any);
    expect(result.subject).toContain('coherence=0.675');
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('warning');
  });
  it('should fail on probe error', async () => {
    const ctx = createMockCtx();
    ctx.db.limit.mockRejectedValueOnce(new Error('DB connection failed'));
    const experiment = new ReasoningAlignmentDriftUnderRlFineTuningExperiment();
    const result = await experiment.probe(ctx as any);
    expect(result.evidence).toHaveProperty('error');
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('fail');
  });
})