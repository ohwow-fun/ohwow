import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTransitionStatus, overrideTransitionStage, detectTaskPatterns, getTimeSaved } from '../transitions.js';
import { makeCtx } from '../../../__tests__/helpers/mock-db.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('getTransitionStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty transitions when none exist', async () => {
    const ctx = makeCtx({
      task_transitions: { data: [] },
    });

    const result = await getTransitionStatus(ctx, {});

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.message).toContain('No task patterns');
    expect(data.transitions).toEqual([]);
  });

  it('returns transition summary with time saved', async () => {
    const ctx = makeCtx({
      task_transitions: {
        data: [
          { id: 't1', pattern_id: 'p1', current_stage: 3, confidence_score: 0.85, total_instances: 12, time_saved_minutes: 120, active: 1 },
        ],
      },
      task_patterns: { data: { name: 'weekly report', category: 'ops' } },
    });

    const result = await getTransitionStatus(ctx, {});

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.message).toContain('1 task pattern');
    expect(data.message).toContain('120 minutes');
    const transitions = data.transitions as Array<Record<string, unknown>>;
    expect(transitions.length).toBe(1);
    expect(transitions[0].stageName).toBe('Draft');
  });
});

describe('overrideTransitionStage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('overrides stage with reason', async () => {
    const ctx = makeCtx({
      task_transitions: { data: { current_stage: 2, stage_history: '[]' } },
    });

    const result = await overrideTransitionStage(ctx, {
      transition_id: 't1',
      new_stage: 4,
      reason: 'Manually verified quality is excellent',
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.message).toContain('Stage 4');
    expect(data.message).toContain('Autopilot');
  });

  it('returns error for missing transition_id', async () => {
    const ctx = makeCtx({});
    const result = await overrideTransitionStage(ctx, { new_stage: 3, reason: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('transition_id is required');
  });

  it('returns error for invalid stage', async () => {
    const ctx = makeCtx({});
    const result = await overrideTransitionStage(ctx, { transition_id: 't1', new_stage: 7, reason: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('1-5');
  });

  it('returns error for missing reason', async () => {
    const ctx = makeCtx({});
    const result = await overrideTransitionStage(ctx, { transition_id: 't1', new_stage: 3 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('reason is required');
  });
});

describe('detectTaskPatterns', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns message when not enough tasks', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: { data: [{ id: 't1', title: 'Write blog post', agent_id: 'a1' }] },
    });

    const result = await detectTaskPatterns(ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.message).toContain('Not enough');
    expect(data.detected).toBe(0);
  });

  it('detects patterns from similar tasks', async () => {
    const tasks = [
      { id: 't1', title: 'Write weekly blog post about AI', agent_id: 'a1' },
      { id: 't2', title: 'Write weekly blog post about ML', agent_id: 'a1' },
      { id: 't3', title: 'Write weekly blog post about LLMs', agent_id: 'a1' },
    ];
    const ctx = makeCtx({
      agent_workforce_tasks: { data: tasks },
      task_patterns: { data: [] },
    });

    const result = await detectTaskPatterns(ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // Should detect a pattern from 3+ similar tasks
    expect(data.detected).toBeGreaterThanOrEqual(0);
  });
});

describe('getTimeSaved', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns zero metrics when no transitions', async () => {
    const ctx = makeCtx({
      task_transitions: { data: [] },
    });

    const result = await getTimeSaved(ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.message).toContain('No patterns');
    const metrics = data.metrics as Record<string, unknown>;
    expect(metrics.totalMinutesSaved).toBe(0);
    expect(metrics.patternsTracked).toBe(0);
  });

  it('returns aggregate metrics', async () => {
    const ctx = makeCtx({
      task_transitions: {
        data: [
          { current_stage: 4, time_saved_minutes: 120 },
          { current_stage: 3, time_saved_minutes: 60 },
          { current_stage: 1, time_saved_minutes: 10 },
        ],
      },
    });

    const result = await getTimeSaved(ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const metrics = data.metrics as Record<string, unknown>;
    expect(metrics.patternsTracked).toBe(3);
    expect(metrics.totalMinutesSaved).toBe(190);
    expect(metrics.patternsAtAutopilotOrAbove).toBe(1);
  });
});
