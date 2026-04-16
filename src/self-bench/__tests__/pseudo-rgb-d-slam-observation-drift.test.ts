import { describe, it, expect, vi } from 'vitest';
import { PseudoRgbDSlamObservationDriftExperiment } from '../experiments/pseudo-rgb-d-slam-observation-drift.js';
describe('PseudoRgbDSlamObservationDriftExperiment', () => {
  it('should pass when no anomalies detected', async () => {
    const experiment = new PseudoRgbDSlamObservationDriftExperiment();
    const mockDb = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ timestamp: '2024-01-01', depth_consistency_score: 0.95 }], error: null }),
    };
    const ctx = { db: mockDb } as any;
    const result = await experiment.probe(ctx);
    expect(result.summary).toContain('avg depth consistency');
    expect(result.evidence).toHaveProperty('avgScore');
    expect(experiment.judge(result, [])).toBe('pass');
  });
  it('should warn when anomalies detected', async () => {
    const experiment = new PseudoRgbDSlamObservationDriftExperiment();
    const mockDb = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [{ timestamp: '2024-01-01', depth_consistency_score: 0.65 }], error: null }),
    };
    const ctx = { db: mockDb } as any;
    const result = await experiment.probe(ctx);
    expect(result.summary).toContain('anomalies 1');
    expect(experiment.judge(result, [])).toBe('warning');
  });
  it('should handle database error gracefully', async () => {
    const experiment = new PseudoRgbDSlamObservationDriftExperiment();
    const mockDb = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection failed' } }),
    };
    const ctx = { db: mockDb } as any;
    const result = await experiment.probe(ctx);
    expect(result.summary).toBe('database query error');
    expect(result.evidence).toHaveProperty('error');
  });
})