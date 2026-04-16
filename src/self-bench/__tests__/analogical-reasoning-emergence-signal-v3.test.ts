import { describe, it, expect, vi } from 'vitest';
import { AnalogicalReasoningEmergenceSignalV3Experiment } from '../experiments/analogical-reasoning-emergence-signal-v3.js';
import type { ExperimentContext, ProbeResult } from '../experiment-types.js';
describe('AnalogicalReasoningEmergenceSignalV3Experiment', () => {
  const createMockCtx = (analogyRows: unknown[], graphRows: unknown[], analogyError?: string, graphError?: string): ExperimentContext => {
    const mockDb = {
      from: vi.fn().mockImplementation((table: string) => {
        const chain: any = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: table === 'model_output_analogies' ? analogyRows : graphRows,
            error: table === 'model_output_analogies' ? analogyError : graphError,
          }),
        };
        return chain;
      }),
    };
    return { db: mockDb } as unknown as ExperimentContext;
  };
  it('should pass when zero-shot analogies exist with high correctness and graph connections', async () => {
    const analogyRows = [
      { id: '1', solution_type: 'zero_shot', correct: true },
      { id: '2', solution_type: 'zero_shot', correct: true },
    ];
    const graphRows = [{ id: 'g1', relation: 'analogy' }];
    const ctx = createMockCtx(analogyRows, graphRows);
    const experiment = new AnalogicalReasoningEmergenceSignalV3Experiment();
    const result = await experiment.probe(ctx);
    expect(result.summary).toContain('zero-shot analogies: 2');
    expect(result.evidence).toMatchObject({ zeroShotCount: 2, correctnessRate: 1, graphConnectionCount: 1 });
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('pass');
  });
  it('should warn when zero-shot analogies exist but correctness is low', async () => {
    const analogyRows = [
      { id: '1', solution_type: 'zero_shot', correct: false },
      { id: '2', solution_type: 'standard', correct: true },
    ];
    const graphRows: unknown[] = [];
    const ctx = createMockCtx(analogyRows, graphRows);
    const experiment = new AnalogicalReasoningEmergenceSignalV3Experiment();
    const result = await experiment.probe(ctx);
    expect(result.summary).toContain('zero-shot analogies: 1');
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('warning');
  });
  it('should fail when no zero-shot analogies and no graph connections', async () => {
    const analogyRows: unknown[] = [];
    const graphRows: unknown[] = [];
    const ctx = createMockCtx(analogyRows, graphRows);
    const experiment = new AnalogicalReasoningEmergenceSignalV3Experiment();
    const result = await experiment.probe(ctx);
    expect(result.summary).toContain('zero-shot analogies: 0');
    const verdict = experiment.judge(result, []);
    expect(verdict).toBe('fail');
  });
})