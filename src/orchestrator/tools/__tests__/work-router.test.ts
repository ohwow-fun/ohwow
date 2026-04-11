import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeTask, getRoutingRecommendations, getWorkloadBalance, recordRoutingOutcome, getTaskAugmentation, triggerPreWork } from '../work-router.js';
import { makeCtx } from '../../../__tests__/helpers/mock-db.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('routeTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires task_title', async () => {
    const ctx = makeCtx();
    const result = await routeTask(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('task_title');
  });

  it('routes task with fallback when no candidates', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: [] },
      agent_workforce_agents: { data: [] },
      work_routing_decisions: { data: [] },
    });

    const result = await routeTask(ctx, { task_title: 'Write blog post' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const decision = data.decision as Record<string, unknown>;
    expect(decision.method).toBe('fallback');
  });

  it('routes to best candidate when agents available', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: [] },
      agent_workforce_agents: {
        data: [
          { id: 'a1', name: 'Content Writer', role: 'content writer', tool_ids: '["write_blog"]', status: 'active' },
          { id: 'a2', name: 'Sales Agent', role: 'sales outreach', tool_ids: '["send_email"]', status: 'active' },
        ],
      },
      work_routing_decisions: { data: [] },
    });

    const result = await routeTask(ctx, {
      task_title: 'Write a blog post about AI',
      required_skills: ['content'],
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const decision = data.decision as Record<string, unknown>;
    const assignee = decision.assignee as Record<string, unknown>;
    expect(assignee.type).toBe('agent');
  });
});

describe('getRoutingRecommendations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires task_title', async () => {
    const ctx = makeCtx();
    const result = await getRoutingRecommendations(ctx, {});
    expect(result.success).toBe(false);
  });

  it('returns recommendation with scores', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: [] },
      agent_workforce_agents: {
        data: [{ id: 'a1', name: 'Ops Agent', role: 'ops', tool_ids: '[]', status: 'active' }],
      },
      work_routing_decisions: { data: [] },
    });

    const result = await getRoutingRecommendations(ctx, { task_title: 'Monitor uptime' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.recommendation).toBeDefined();
  });
});

describe('getWorkloadBalance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty when no decisions', async () => {
    const ctx = makeCtx({
      work_routing_decisions: { data: [] },
    });

    const result = await getWorkloadBalance(ctx);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.workload).toEqual([]);
  });
});

describe('recordRoutingOutcome', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires decision_id', async () => {
    const ctx = makeCtx();
    const result = await recordRoutingOutcome(ctx, {});
    expect(result.success).toBe(false);
  });

  it('requires valid outcome', async () => {
    const ctx = makeCtx();
    const result = await recordRoutingOutcome(ctx, { decision_id: 'd1', outcome: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('records outcome successfully', async () => {
    const ctx = makeCtx({
      work_routing_decisions: { data: null },
    });

    const result = await recordRoutingOutcome(ctx, {
      decision_id: 'd1',
      outcome: 'completed',
      quality_score: 0.9,
    });
    expect(result.success).toBe(true);
  });
});

describe('getTaskAugmentation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires decision_id', async () => {
    const ctx = makeCtx();
    const result = await getTaskAugmentation(ctx, {});
    expect(result.success).toBe(false);
  });

  it('returns augmentations for decision', async () => {
    const ctx = makeCtx({
      work_augmentations: { data: [
        { id: 'aug1', phase: 'pre', status: 'completed', augmentation_type: 'context_gathering' },
      ] },
    });

    const result = await getTaskAugmentation(ctx, { decision_id: 'd1' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect((data.augmentations as unknown[]).length).toBe(1);
  });
});

describe('triggerPreWork', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires decision_id', async () => {
    const ctx = makeCtx();
    const result = await triggerPreWork(ctx, {});
    expect(result.success).toBe(false);
  });

  it('creates pre-work augmentation', async () => {
    const ctx = makeCtx({
      work_augmentations: { data: null },
    });

    const result = await triggerPreWork(ctx, {
      decision_id: 'd1',
      augmentation_type: 'doc_summary',
      description: 'Summarize relevant docs',
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.augmentation_id).toBeDefined();
  });
});
