import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkPatterns, getTimeAllocation, detectAutomationOpportunities, getObservationInsights } from '../observation.js';
import { makeCtx } from '../../../__tests__/helpers/mock-db.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('getWorkPatterns', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires person_id', async () => {
    const ctx = makeCtx();
    const result = await getWorkPatterns(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('person_id');
  });

  it('returns cached map if recent', async () => {
    const recentMap = JSON.stringify({
      computedAt: new Date().toISOString(),
      communication: {},
      insights: [],
    });
    const ctx = makeCtx({
      agent_workforce_person_models: { data: { work_pattern_map: recentMap } },
    });

    const result = await getWorkPatterns(ctx, { person_id: 'p1' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.cached).toBe(true);
  });

  it('computes fresh map when stale', async () => {
    const staleMap = JSON.stringify({ computedAt: '2020-01-01T00:00:00Z' });
    const ctx = makeCtx({
      agent_workforce_person_models: {
        data: { id: 'p1', name: 'Test', work_pattern_map: staleMap, energy_patterns: '{}', friction_points: '[]', flow_triggers: '[]' },
      },
      orchestrator_conversations: { data: [] },
      whatsapp_chat_messages: { data: [] },
      telegram_chat_messages: { data: [] },
      work_routing_decisions: { data: [] },
      agent_workforce_tasks: { data: [] },
      meeting_sessions: { data: [] },
      agent_workforce_workflow_runs: { data: [] },
      task_transitions: { data: [] },
      agent_workforce_workflows: { data: [] },
      local_triggers: { data: [] },
      agent_workforce_knowledge_documents: { data: [] },
      skill_progression: { data: [] },
      consciousness_items: { data: [] },
      agent_workforce_anomaly_alerts: { data: [] },
      recovery_audit_log: { data: [] },
      resource_usage_daily: { data: [] },
      data_source_connectors: { data: [] },
      agent_workforce_person_observations: { data: null },
    });

    const result = await getWorkPatterns(ctx, { person_id: 'p1' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.cached).toBe(false);
    expect(data.patternMap).toBeDefined();
  });
});

describe('getTimeAllocation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires person_id', async () => {
    const ctx = makeCtx();
    const result = await getTimeAllocation(ctx, {});
    expect(result.success).toBe(false);
  });

  it('returns time allocation breakdown', async () => {
    const ctx = makeCtx({
      work_routing_decisions: { data: [] },
      orchestrator_conversations: { data: [] },
      whatsapp_chat_messages: { data: [] },
      telegram_chat_messages: { data: [] },
      meeting_sessions: { data: [] },
      agent_workforce_tasks: { data: [] },
      agent_workforce_workflow_runs: { data: [] },
    });

    const result = await getTimeAllocation(ctx, { person_id: 'p1' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.allocation).toBeDefined();
  });
});

describe('detectAutomationOpportunities', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty when not enough tasks', async () => {
    const ctx = makeCtx({
      agent_workforce_tasks: { data: [] },
    });

    const result = await detectAutomationOpportunities(ctx);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.opportunities).toEqual([]);
  });

  it('detects clusters of similar tasks', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      title: 'Weekly blog post draft', agent_id: 'a1',
    }));
    const ctx = makeCtx({
      agent_workforce_tasks: { data: tasks },
      task_patterns: { data: [] },
    });

    const result = await detectAutomationOpportunities(ctx);
    expect(result.success).toBe(true);
  });
});

describe('getObservationInsights', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires person_id', async () => {
    const ctx = makeCtx();
    const result = await getObservationInsights(ctx, {});
    expect(result.success).toBe(false);
  });

  it('returns insights from pattern analysis', async () => {
    const ctx = makeCtx({
      agent_workforce_person_models: {
        data: { id: 'p1', name: 'Test', work_pattern_map: '{}', energy_patterns: '{}', friction_points: '[]', flow_triggers: '[]' },
      },
      orchestrator_conversations: { data: [] },
      whatsapp_chat_messages: { data: [] },
      telegram_chat_messages: { data: [] },
      work_routing_decisions: { data: [] },
      agent_workforce_tasks: { data: [] },
      meeting_sessions: { data: [] },
      agent_workforce_workflow_runs: { data: [] },
      task_transitions: { data: [] },
      agent_workforce_workflows: { data: [] },
      local_triggers: { data: [] },
      agent_workforce_knowledge_documents: { data: [] },
      skill_progression: { data: [] },
      consciousness_items: { data: [] },
      agent_workforce_anomaly_alerts: { data: [] },
      recovery_audit_log: { data: [] },
      resource_usage_daily: { data: [] },
      data_source_connectors: { data: [] },
      agent_workforce_person_observations: { data: null },
    });

    const result = await getObservationInsights(ctx, { person_id: 'p1' });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.insights).toBeDefined();
  });
});
