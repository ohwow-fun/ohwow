import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPersonModel, listPersonModels, startPersonIngestion, updatePersonModel } from '../person-model.js';
import { makeCtx } from '../../../__tests__/helpers/mock-db.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const PERSON_ROW = {
  id: 'pm-1',
  name: 'Jesus',
  email: 'jesus@test.com',
  role_title: 'Founder',
  variant: 'founder',
  ingestion_status: 'initial_complete',
  domain_expertise: '{"product":9,"marketing":6}',
  blind_spots: '["legal"]',
  skills_map: '{"typescript":10}',
  tool_proficiency: '{"claude":10}',
  communication_style: '{"preference":"async"}',
  energy_patterns: '{"peak":"morning"}',
  learning_style: 'hands-on',
  ambitions: '{"goal":"build the OS for work"}',
  values_and_motivations: '["autonomy","craft"]',
  friction_points: '["repetitive tasks"]',
  flow_triggers: '["deep architecture work"]',
  skill_gaps_to_close: '["sales"]',
  growth_arc: '{}',
  growth_direction: 'ascending',
  observation_count: 12,
  refinement_count: 2,
};

describe('getPersonModel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns person model when found', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: PERSON_ROW },
    });

    const result = await getPersonModel(ctx, { person_id: 'pm-1' });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const pm = data.personModel as Record<string, unknown>;
    expect(pm.name).toBe('Jesus');
    expect(pm.variant).toBe('founder');
    expect(pm.domainExpertise).toEqual({ product: 9, marketing: 6 });
    expect(pm.blindSpots).toEqual(['legal']);
    expect(pm.flowTriggers).toEqual(['deep architecture work']);
  });

  it('returns not-found message when model missing', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: null, error: { message: 'Not found' } },
    });

    const result = await getPersonModel(ctx, { person_id: 'pm-missing' });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.exists).toBe(false);
  });
});

describe('listPersonModels', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns list of models', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: {
        data: [
          { id: 'pm-1', name: 'Jesus', email: 'j@test.com', role_title: 'Founder', variant: 'founder', ingestion_status: 'initial_complete', growth_direction: 'ascending', observation_count: 12 },
          { id: 'pm-2', name: 'Ana', email: 'a@test.com', role_title: 'Designer', variant: 'team_member', ingestion_status: 'not_started', growth_direction: 'ascending', observation_count: 0 },
        ],
      },
    });

    const result = await listPersonModels(ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.message).toContain('2 Person Models');
    expect((data.models as unknown[]).length).toBe(2);
  });

  it('returns helpful message when no models', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: [] },
    });

    const result = await listPersonModels(ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.message).toContain('start_person_ingestion');
  });
});

describe('startPersonIngestion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates new person model with founder interview guide', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: null },
    });

    const result = await startPersonIngestion(ctx, { name: 'Jesus', variant: 'founder' });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.message).toContain('Created Person Model for Jesus');
    expect(data.personModelId).toBeDefined();
    const guide = data.interviewGuide as Record<string, unknown>;
    expect(guide.variant).toBe('founder');
    expect((guide.steps as unknown[]).length).toBe(4);
  });

  it('resumes existing person model', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: { id: 'pm-1', ingestion_status: 'not_started' } },
    });

    const result = await startPersonIngestion(ctx, { name: 'Jesus', variant: 'founder' });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.message).toContain('Resuming');
    expect(data.personModelId).toBe('pm-1');
  });

  it('returns error when name missing', async () => {
    const ctx = makeCtx({});
    const result = await startPersonIngestion(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toBe('name is required');
  });

  it('returns error for invalid variant', async () => {
    const ctx = makeCtx({});
    const result = await startPersonIngestion(ctx, { name: 'X', variant: 'robot' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('variant');
  });
});

describe('updatePersonModel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates dimensions successfully', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: null },
      agent_workforce_person_observations: { data: null },
    });

    const result = await updatePersonModel(ctx, {
      person_id: 'pm-1',
      updates: { skills_map: { typescript: 10, python: 7 } },
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect((data.updatedDimensions as string[])).toContain('skills_map');
  });

  it('logs observation when provided', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: null },
      agent_workforce_person_observations: { data: null },
    });

    const result = await updatePersonModel(ctx, {
      person_id: 'pm-1',
      updates: { energy_patterns: { peak: 'morning' } },
      observation: 'User mentioned they work best in the morning',
      observation_type: 'self_report',
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid dimension', async () => {
    const ctx = makeCtx({});
    const result = await updatePersonModel(ctx, {
      person_id: 'pm-1',
      updates: { favorite_color: 'blue' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid dimension');
  });

  it('returns error when person_id missing', async () => {
    const ctx = makeCtx({});
    const result = await updatePersonModel(ctx, { updates: { skills_map: {} } });
    expect(result.success).toBe(false);
    expect(result.error).toBe('person_id is required');
  });

  it('returns error when updates empty', async () => {
    const ctx = makeCtx({});
    const result = await updatePersonModel(ctx, { person_id: 'pm-1', updates: {} });
    expect(result.success).toBe(false);
    expect(result.error).toContain('at least one dimension');
  });
});
