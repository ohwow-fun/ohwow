import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getHumanGrowth, getSkillPaths, createSkillPath, getTeamHealth, getDelegationMetrics, recordSkillAssessment } from '../human-growth.js';
import { makeCtx } from '../../../__tests__/helpers/mock-db.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('getHumanGrowth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires person_id', async () => {
    const ctx = makeCtx();
    const result = await getHumanGrowth(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('person_id');
  });

  it('returns error when person not found', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: null },
    });
    const result = await getHumanGrowth(ctx, { person_id: 'p1' });
    expect(result.success).toBe(false);
  });

  it('computes growth snapshot from person data', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: {
        data: {
          id: 'p1', name: 'Jesus', skills_map: '{}', domain_expertise: '{"marketing": 0.8}',
          growth_snapshots: '[]', growth_arc: '{}', growth_velocity: 0, growth_direction: 'plateau',
          skill_gaps_to_close: '[]', role_title: 'Founder', ingestion_status: 'initial_complete',
        },
      },
      work_routing_decisions: { data: [] },
      work_augmentations: { data: [] },
      agent_workforce_person_observations: { data: [] },
    });

    const result = await getHumanGrowth(ctx, { person_id: 'p1' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.snapshot).toBeDefined();
    expect(data.signals).toBeDefined();
  });
});

describe('getSkillPaths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires person_id', async () => {
    const ctx = makeCtx();
    const result = await getSkillPaths(ctx, {});
    expect(result.success).toBe(false);
  });

  it('returns empty paths when none exist', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: { skills_map: '{}' } },
      growth_milestones: { data: [] },
    });

    const result = await getSkillPaths(ctx, { person_id: 'p1' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.paths).toEqual([]);
  });
});

describe('createSkillPath', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires person_id and skill_name', async () => {
    const ctx = makeCtx();
    let result = await createSkillPath(ctx, {});
    expect(result.success).toBe(false);

    result = await createSkillPath(ctx, { person_id: 'p1' });
    expect(result.success).toBe(false);
  });

  it('creates path when person exists', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: { skills_map: '{"writing": 0.1}' } },
      growth_milestones: { data: null },
    });

    const result = await createSkillPath(ctx, { person_id: 'p1', skill_name: 'writing' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const path = data.path as Record<string, unknown>;
    expect((path.milestones as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('getTeamHealth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns report with zero people', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: [] },
    });

    const result = await getTeamHealth(ctx);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.message).toContain('No profiled team members');
  });
});

describe('getDelegationMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires person_id', async () => {
    const ctx = makeCtx();
    const result = await getDelegationMetrics(ctx, {});
    expect(result.success).toBe(false);
  });

  it('returns metrics when delegation data exists', async () => {
    const ctx = makeCtx({
      delegation_decisions: { data: [
        { outcome: 'successful', delegated_to_type: 'agent', created_at: '2026-04-10' },
        { outcome: 'pending', delegated_to_type: 'agent', created_at: '2026-04-11' },
      ] },
      work_routing_decisions: { data: [] },
    });

    const result = await getDelegationMetrics(ctx, { person_id: 'p1' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const metrics = data.metrics as Record<string, unknown>;
    expect(metrics.totalDecisions).toBe(2);
  });
});

describe('recordSkillAssessment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires person_id, skill_name, new_level', async () => {
    const ctx = makeCtx();
    let result = await recordSkillAssessment(ctx, {});
    expect(result.success).toBe(false);

    result = await recordSkillAssessment(ctx, { person_id: 'p1', skill_name: 'writing' });
    expect(result.success).toBe(false);
  });

  it('validates new_level range', async () => {
    const ctx = makeCtx();
    const result = await recordSkillAssessment(ctx, { person_id: 'p1', skill_name: 'writing', new_level: 1.5 });
    expect(result.success).toBe(false);
  });

  it('records assessment when valid', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: { skills_map: '{"writing": 0.3}' } },
      skill_progression: { data: null },
      growth_milestones: { data: [] },
    });

    const result = await recordSkillAssessment(ctx, {
      person_id: 'p1', skill_name: 'writing', new_level: 0.5, source: 'peer_observation',
    });
    expect(result.success).toBe(true);
  });
});
