import { describe, it, expect } from 'vitest';
import { analyzeAgentGaps, type GapAnalysisInput } from '../agent-gap-analysis-core.js';

function baseInput(overrides: Partial<GapAnalysisInput> = {}): GapAnalysisInput {
  return {
    workspaceId: 'ws-1',
    businessType: 'saas',
    growthStage: 2,
    agents: [],
    departments: [],
    taskStats: { byAgent: [], fallbackCount: 0, failedTaskTitles: [] },
    goals: [],
    presets: [],
    existingSuggestionRoles: [],
    focusAreas: [],
    ...overrides,
  };
}

describe('analyzeAgentGaps', () => {
  it('returns empty array when no gaps detected', () => {
    expect(analyzeAgentGaps(baseInput())).toEqual([]);
  });

  it('caps at 3 suggestions max', () => {
    const input = baseInput({
      taskStats: {
        byAgent: [
          { agentId: 'a1', agentName: 'Agent1', total: 50, failed: 0 },
          { agentId: 'a2', agentName: 'Agent2', total: 5, failed: 0 },
        ],
        fallbackCount: 5,
        failedTaskTitles: Array.from({ length: 10 }, (_, i) => `invoice processing task ${i}`),
      },
      focusAreas: ['content', 'leads'],
      goals: [{ title: 'Improve SEO rankings', targetMetric: 'organic traffic', status: 'active' }],
    });
    const suggestions = analyzeAgentGaps(input);
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('deduplicates by suggested role (case-insensitive)', () => {
    // Two rules could suggest same role — should only appear once
    const input = baseInput({
      taskStats: { byAgent: [], fallbackCount: 5, failedTaskTitles: [] },
      focusAreas: ['content'],
    });
    const suggestions = analyzeAgentGaps(input);
    const roles = suggestions.map((s) => s.suggestedRole.toLowerCase());
    const uniqueRoles = new Set(roles);
    expect(roles.length).toBe(uniqueRoles.size);
  });

  it('skips suggestions for roles already covered by existing agents', () => {
    const input = baseInput({
      agents: [{ id: 'a1', name: 'Writer', role: 'Content Writer', department: 'Marketing' }],
      focusAreas: ['content'],
    });
    const suggestions = analyzeAgentGaps(input);
    const contentSuggestion = suggestions.find((s) => s.suggestedRole === 'Content Writer');
    expect(contentSuggestion).toBeUndefined();
  });

  it('skips suggestions matching existingSuggestionRoles', () => {
    const input = baseInput({
      existingSuggestionRoles: ['General Purpose Assistant'],
      taskStats: { byAgent: [], fallbackCount: 5, failedTaskTitles: [] },
    });
    const suggestions = analyzeAgentGaps(input);
    const gpa = suggestions.find((s) => s.suggestedRole === 'General Purpose Assistant');
    expect(gpa).toBeUndefined();
  });
});

describe('Rule 1: task_fallback', () => {
  it('triggers when fallbackCount >= 3', () => {
    const input = baseInput({
      taskStats: { byAgent: [], fallbackCount: 3, failedTaskTitles: [] },
    });
    const suggestions = analyzeAgentGaps(input);
    expect(suggestions.some((s) => s.gapType === 'task_fallback')).toBe(true);
  });

  it('does not trigger when fallbackCount < 3', () => {
    const input = baseInput({
      taskStats: { byAgent: [], fallbackCount: 2, failedTaskTitles: [] },
    });
    const suggestions = analyzeAgentGaps(input);
    expect(suggestions.some((s) => s.gapType === 'task_fallback')).toBe(false);
  });
});

describe('Rule 2: overloaded_agent', () => {
  it('triggers when agent has 3x avg volume AND >= 15 tasks', () => {
    // With 4 agents: total=15+1+1+1=18, avg=4.5, need agent.total >= 4.5*3=13.5 AND >=15
    // 15 >= 13.5 ✓ AND 15 >= 15 ✓
    // Agent a1 not in agents array so suggested role defaults to "General (Support)"
    const input = baseInput({
      agents: [
        { id: 'a2', name: 'B', role: 'Coordinator', department: 'Ops' },
        { id: 'a3', name: 'C', role: 'Planner', department: 'Ops' },
        { id: 'a4', name: 'D', role: 'Reviewer', department: 'Ops' },
      ],
      taskStats: {
        byAgent: [
          { agentId: 'a1', agentName: 'Overworked', total: 15, failed: 0 },
          { agentId: 'a2', agentName: 'B', total: 1, failed: 0 },
          { agentId: 'a3', agentName: 'C', total: 1, failed: 0 },
          { agentId: 'a4', agentName: 'D', total: 1, failed: 0 },
        ],
        fallbackCount: 0,
        failedTaskTitles: [],
      },
    });
    const suggestions = analyzeAgentGaps(input);
    expect(suggestions.some((s) => s.gapType === 'overloaded_agent')).toBe(true);
  });

  it('does not trigger with fewer than 2 agents', () => {
    const input = baseInput({
      agents: [{ id: 'a1', name: 'Solo', role: 'General', department: 'Ops' }],
      taskStats: {
        byAgent: [{ agentId: 'a1', agentName: 'Solo', total: 50, failed: 0 }],
        fallbackCount: 0,
        failedTaskTitles: [],
      },
    });
    const suggestions = analyzeAgentGaps(input);
    expect(suggestions.some((s) => s.gapType === 'overloaded_agent')).toBe(false);
  });
});

describe('Rule 3: failed_domain', () => {
  it('triggers when 5+ failed tasks share keywords', () => {
    const input = baseInput({
      taskStats: {
        byAgent: [],
        fallbackCount: 0,
        failedTaskTitles: [
          'invoice processing failed',
          'invoice generation error',
          'send invoice to client',
          'invoice template broken',
          'create invoice for order',
        ],
      },
    });
    const suggestions = analyzeAgentGaps(input);
    expect(suggestions.some((s) => s.gapType === 'failed_domain')).toBe(true);
  });

  it('skips keywords already covered by an agent role', () => {
    const input = baseInput({
      agents: [{ id: 'a1', name: 'Invoice Bot', role: 'Invoice Specialist', department: 'Finance' }],
      taskStats: {
        byAgent: [],
        fallbackCount: 0,
        failedTaskTitles: [
          'invoice processing failed',
          'invoice generation error',
          'send invoice to client',
          'invoice template broken',
          'create invoice for order',
        ],
      },
    });
    const suggestions = analyzeAgentGaps(input);
    expect(suggestions.some((s) => s.gapType === 'failed_domain')).toBe(false);
  });
});

describe('Rule 4: growth_stage_gap', () => {
  it('triggers when focus area keywords map to unmet roles', () => {
    const input = baseInput({
      focusAreas: ['content'],
    });
    const suggestions = analyzeAgentGaps(input);
    expect(suggestions.some((s) => s.gapType === 'growth_stage_gap')).toBe(true);
    expect(suggestions.find((s) => s.gapType === 'growth_stage_gap')?.suggestedRole).toBe('Content Writer');
  });
});

describe('Rule 5: department_gap', () => {
  it('triggers when business type presets have departments the workspace lacks', () => {
    const input = baseInput({
      businessType: 'saas',
      departments: [{ id: 'd1', name: 'Marketing' }],
      presets: [
        { presetId: 'p1', agentRole: 'Customer Success Manager', departmentName: 'Support', businessType: 'saas' },
      ],
      taskStats: {
        byAgent: [{ agentId: 'a1', agentName: 'Writer', total: 10, failed: 0 }],
        fallbackCount: 0,
        failedTaskTitles: [],
      },
    });
    const suggestions = analyzeAgentGaps(input);
    expect(suggestions.some((s) => s.gapType === 'department_gap')).toBe(true);
  });

  it('requires at least 5 total tasks', () => {
    const input = baseInput({
      businessType: 'saas',
      presets: [
        { presetId: 'p1', agentRole: 'Support Agent', departmentName: 'Support', businessType: 'saas' },
      ],
      taskStats: {
        byAgent: [{ agentId: 'a1', agentName: 'Writer', total: 3, failed: 0 }],
        fallbackCount: 0,
        failedTaskTitles: [],
      },
    });
    const suggestions = analyzeAgentGaps(input);
    expect(suggestions.some((s) => s.gapType === 'department_gap')).toBe(false);
  });
});

describe('Rule 6: goal_coverage_gap', () => {
  it('triggers when active goals have keywords no agent covers', () => {
    const input = baseInput({
      goals: [{ title: 'Increase content output', targetMetric: null, status: 'active' }],
    });
    const suggestions = analyzeAgentGaps(input);
    expect(suggestions.some((s) => s.gapType === 'goal_coverage_gap')).toBe(true);
  });
});
