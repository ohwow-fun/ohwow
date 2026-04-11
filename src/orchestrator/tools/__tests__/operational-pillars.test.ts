import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assessOperations, getPillarDetail, buildPillar, updatePillarStatus } from '../operational-pillars.js';
import { makeCtx } from '../../../__tests__/helpers/mock-db.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const PILLAR_CONTENT = {
  id: 'p1',
  slug: 'content_pipeline',
  name: 'Content Pipeline',
  description: 'Systematic content creation and distribution.',
  category: 'acquisition',
  icon: 'pencil-line',
  business_types: '[]',
  min_stage: 0,
  max_stage: 9,
  priority_by_stage: '{"0":"important","1":"critical","2":"critical"}',
  kpis: '[{"name":"Posts per week","target":2,"unit":"count"}]',
  best_practices: '[]',
  setup_steps: '[{"order":1,"title":"Audit content","description":"Review what exists.","agent_role":"Content Strategist"}]',
  estimated_setup_hours: 3,
  prerequisite_pillar_ids: '[]',
};

const PILLAR_OUTBOUND = {
  id: 'p2',
  slug: 'outbound_outreach',
  name: 'Outbound Outreach',
  description: 'Proactive outreach to potential customers.',
  category: 'acquisition',
  icon: 'send',
  business_types: '[]',
  min_stage: 0,
  max_stage: 6,
  priority_by_stage: '{"0":"critical","1":"critical"}',
  kpis: '[]',
  best_practices: '[]',
  setup_steps: '[]',
  estimated_setup_hours: 2,
  prerequisite_pillar_ids: '[]',
};

describe('assessOperations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns gap analysis for workspace', async () => {
    const ctx = makeCtx({
      agent_workforce_workspaces: { data: { business_type: 'saas_startup', growth_stage: 1 } },
      agent_workforce_operational_pillars: { data: [PILLAR_CONTENT, PILLAR_OUTBOUND] },
      agent_workforce_pillar_instances: { data: [] },
    });

    const result = await assessOperations(ctx, {});

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.assessment).toBeDefined();
    const assessment = data.assessment as Record<string, unknown>;
    expect(assessment.businessType).toBe('saas_startup');
    expect(assessment.growthStage).toBe(1);
    expect(assessment.totalPillarsApplicable).toBe(2);
    expect(assessment.missing).toBe(2);
    expect((assessment.criticalGaps as unknown[]).length).toBe(2); // both are critical at stage 1
  });

  it('filters by category', async () => {
    const ctx = makeCtx({
      agent_workforce_workspaces: { data: { business_type: 'saas_startup', growth_stage: 0 } },
      agent_workforce_operational_pillars: { data: [PILLAR_CONTENT] },
      agent_workforce_pillar_instances: { data: [] },
    });

    const result = await assessOperations(ctx, { category_filter: 'acquisition' });

    expect(result.success).toBe(true);
  });

  it('returns error when workspace not found', async () => {
    const ctx = makeCtx({
      agent_workforce_workspaces: { data: null, error: { message: 'Not found' } },
    });

    const result = await assessOperations(ctx, {});

    expect(result.success).toBe(false);
    expect(result.error).toBe('Not found');
  });
});

describe('getPillarDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns pillar with status not_started when no instance', async () => {
    const ctx = makeCtx({
      agent_workforce_operational_pillars: { data: PILLAR_CONTENT },
      agent_workforce_pillar_instances: { data: null },
      agent_workforce_workspaces: { data: { growth_stage: 1 } },
    });

    const result = await getPillarDetail(ctx, { pillar_slug: 'content_pipeline' });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect((data.pillar as Record<string, unknown>).slug).toBe('content_pipeline');
    expect((data.currentStatus as Record<string, unknown>).status).toBe('not_started');
  });

  it('returns error when slug missing', async () => {
    const ctx = makeCtx({});
    const result = await getPillarDetail(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toBe('pillar_slug is required');
  });
});

describe('buildPillar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates instance and returns blueprint', async () => {
    const ctx = makeCtx({
      agent_workforce_operational_pillars: { data: PILLAR_CONTENT },
      agent_workforce_workspaces: { data: { business_name: 'TestCo', business_type: 'saas_startup', business_description: 'SaaS', growth_stage: 1, team_size: 2 } },
      agent_workforce_pillar_instances: { data: null },
    });

    const result = await buildPillar(ctx, { pillar_slug: 'content_pipeline' });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.message).toContain('Started building');
    expect(data.blueprint).toBeDefined();
    const bp = data.blueprint as Record<string, unknown>;
    expect(bp.pillarSlug).toBe('content_pipeline');
  });

  it('returns error when slug missing', async () => {
    const ctx = makeCtx({});
    const result = await buildPillar(ctx, {});
    expect(result.success).toBe(false);
  });
});

describe('updatePillarStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error for invalid status', async () => {
    const ctx = makeCtx({});
    const result = await updatePillarStatus(ctx, { pillar_slug: 'content_pipeline', status: 'invalid' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid status');
  });

  it('returns error when slug missing', async () => {
    const ctx = makeCtx({});
    const result = await updatePillarStatus(ctx, { status: 'running' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('pillar_slug is required');
  });

  it('returns error when status missing', async () => {
    const ctx = makeCtx({});
    const result = await updatePillarStatus(ctx, { pillar_slug: 'content_pipeline' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('status is required');
  });
});
