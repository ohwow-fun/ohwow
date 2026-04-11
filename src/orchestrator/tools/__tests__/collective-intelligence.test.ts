import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCrossPollination, scheduleTeamCouncil, getCollectiveBriefing, rebalanceWorkload } from '../collective-intelligence.js';
import { makeCtx } from '../../../__tests__/helpers/mock-db.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('getCrossPollination', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty when not enough people', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: [] },
      work_routing_decisions: { data: [] },
    });
    const result = await getCrossPollination(ctx);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.suggestions).toEqual([]);
  });
});

describe('scheduleTeamCouncil', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns topics when team issues detected', async () => {
    const ctx = makeCtx({
      work_routing_decisions: { data: [] },
      agent_workforce_person_models: { data: [] },
      pillar_instances: { data: [] },
    });
    const result = await scheduleTeamCouncil(ctx);
    expect(result.success).toBe(true);
  });
});

describe('getCollectiveBriefing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires person_id', async () => {
    const ctx = makeCtx();
    const result = await getCollectiveBriefing(ctx, {});
    expect(result.success).toBe(false);
  });

  it('assembles briefing from team data', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: [] },
      agent_workforce_agents: { data: [] },
      work_routing_decisions: { data: [] },
      consciousness_items: { data: [] },
    });
    const result = await getCollectiveBriefing(ctx, { person_id: 'p1' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.briefing).toBeDefined();
  });
});

describe('rebalanceWorkload', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns balanced when no overload', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: { data: [] },
      agent_workforce_agents: { data: [] },
      work_routing_decisions: { data: [] },
    });
    const result = await rebalanceWorkload(ctx);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.capacity).toBeDefined();
  });
});
