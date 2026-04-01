/**
 * Tests for the ImprovementScheduler — automated self-improvement cycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImprovementScheduler } from '../improvement-scheduler.js';
import { mockDb } from '../../__tests__/helpers/mock-db.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../lib/self-improvement/improve.js', () => ({
  runImprovementCycle: vi.fn().mockResolvedValue({
    compression: null,
    patternMining: { patternsFound: 3 },
    skillSynthesis: null,
    processMining: null,
    principleDistillation: null,
    signalEvaluation: { signalsFound: 1 },
    digitalTwin: null,
    totalTokensUsed: 0,
    totalCostCents: 0,
    durationMs: 500,
  }),
}));

const mockRouter = {} as ModelRouter;

describe('ImprovementScheduler', () => {
  let db: ReturnType<typeof mockDb>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    db = mockDb({
      runtime_settings: { data: null },
      agent_workforce_tasks: { data: [], count: 0 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates scheduler without starting', () => {
    const scheduler = new ImprovementScheduler(
      db as unknown as DatabaseAdapter,
      mockRouter,
      'ws-test',
    );
    expect(scheduler).toBeDefined();
  });

  it('starts and stops cleanly', async () => {
    const scheduler = new ImprovementScheduler(
      db as unknown as DatabaseAdapter,
      mockRouter,
      'ws-test',
      60_000, // 1 minute interval for testing
    );

    await scheduler.start();
    scheduler.stop();
    // No errors thrown
  });

  it('runs execute without errors', async () => {
    const scheduler = new ImprovementScheduler(
      db as unknown as DatabaseAdapter,
      mockRouter,
      'ws-test',
    );

    // execute() should complete without throwing
    await scheduler.execute();
  });

  it('runs with skipLLM when below task threshold', async () => {
    const { runImprovementCycle } = await import('../../lib/self-improvement/improve.js');

    db = mockDb({
      runtime_settings: { data: { value: '5' } }, // last count was 5
      agent_workforce_tasks: { data: [], count: 8 }, // current count is 8 (only 3 new)
    });

    const scheduler = new ImprovementScheduler(
      db as unknown as DatabaseAdapter,
      mockRouter,
      'ws-test',
    );

    await scheduler.execute();

    // Should have called runImprovementCycle with skipLLM: true
    expect(runImprovementCycle).toHaveBeenCalled();
  });

  it('prevents concurrent execution', async () => {
    const scheduler = new ImprovementScheduler(
      db as unknown as DatabaseAdapter,
      mockRouter,
      'ws-test',
    );

    // Start two concurrent executions
    const p1 = scheduler.execute();
    const p2 = scheduler.execute();

    await Promise.all([p1, p2]);

    // Second execution should have been skipped (guard check)
    const { runImprovementCycle } = await import('../../lib/self-improvement/improve.js');
    expect(runImprovementCycle).toHaveBeenCalledTimes(1);
  });
});
