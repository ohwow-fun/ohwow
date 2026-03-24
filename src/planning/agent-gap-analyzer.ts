/**
 * Agent Gap Analyzer — Local runtime version
 * Gathers workspace data via DatabaseAdapter and runs heuristic analysis
 * to detect when a new specialized agent would help.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';

// ============================================================================
// Re-export core types and constants
// ============================================================================

export type { AgentSuggestion, GapType, GapAnalysisInput } from './agent-gap-analysis-core.js';
export { analyzeAgentGaps, BUSINESS_TYPE_RECOMMENDED_ROLES } from './agent-gap-analysis-core.js';

import { analyzeAgentGaps, BUSINESS_TYPE_RECOMMENDED_ROLES } from './agent-gap-analysis-core.js';
import type { GapAnalysisInput, AgentSuggestion } from './agent-gap-analysis-core.js';

// ============================================================================
// GROWTH STAGE FOCUS AREAS (duplicated from web app since the local runtime
// doesn't import from src/lib/growth/stages)
// ============================================================================

const GROWTH_STAGE_FOCUS: Record<number, string[]> = {
  0: ['Build MVP', 'Share it free', 'Collect feedback', 'Find early users'],
  1: ['First paying customer', 'Pricing strategy', 'Sales conversations', 'Value proposition'],
  2: ['Pick one channel', 'Create content', 'Generate leads', 'Build audience'],
  3: ['Document processes', 'Set up automation', 'Delegate tasks', 'Create SOPs'],
  4: ['Identify ideal customers', 'Say no to the rest', 'Streamline operations', 'Apply 80/20'],
  5: ['Second product/service', 'Increase LTV', 'Upsell strategy', 'Partnership channels'],
  6: ['Improve margins', 'Automate operations', 'Cut waste', 'Optimize pricing'],
  7: ['Build departments', 'Assign leadership roles', 'Create org chart', 'Leadership development'],
  8: ['Deep niche expertise', 'Thought leadership', 'Market share', 'Brand authority'],
  9: ['Enterprise value', 'Recurring revenue', 'Exit readiness', 'Legacy systems'],
};

// ============================================================================
// LOCAL RUNTIME DATA GATHERING
// ============================================================================

/**
 * Run a full gap analysis for a workspace.
 * Uses DatabaseAdapter (SQLite) instead of Supabase.
 */
export async function runLocalGapAnalysis(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<AgentSuggestion[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    workspaceResult,
    agentsResult,
    departmentsResult,
    taskStatsResult,
    failedTasksResult,
    fallbackTasksResult,
    goalsResult,
    existingSuggestionsResult,
  ] = await Promise.all([
    db.from('agent_workforce_workspaces')
      .select('business_type, growth_stage')
      .eq('id', workspaceId)
      .single(),

    db.from('agent_workforce_agents')
      .select('id, name, role, department_id')
      .eq('workspace_id', workspaceId),

    db.from('agent_workforce_departments')
      .select('id, name')
      .eq('workspace_id', workspaceId),

    db.from('agent_workforce_tasks')
      .select('agent_id, status')
      .eq('workspace_id', workspaceId)
      .gte('created_at', thirtyDaysAgo),

    db.from('agent_workforce_tasks')
      .select('title')
      .eq('workspace_id', workspaceId)
      .eq('status', 'failed')
      .gte('created_at', thirtyDaysAgo)
      .limit(50),

    // SQLite stores metadata as JSON text; use raw count via workaround
    // For now, count tasks where metadata contains the fallback flag
    // The adapter doesn't support contains(), so we fetch all and filter in JS
    db.from('agent_workforce_tasks')
      .select('id, metadata')
      .eq('workspace_id', workspaceId)
      .gte('created_at', thirtyDaysAgo),

    db.from('agent_workforce_goals')
      .select('title, target_metric, status')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active'),

    db.from('agent_workforce_agent_suggestions')
      .select('suggested_role')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active'),
  ]);

  const ws = workspaceResult.data as { business_type?: string; growth_stage?: number } | null;
  const growthStage = ws?.growth_stage ?? 0;
  const businessType = ws?.business_type || '';

  const departments = ((departmentsResult.data || []) as Array<{ id: string; name: string }>);
  const deptMap = new Map(departments.map((d) => [d.id, d.name]));

  const agents = ((agentsResult.data || []) as Array<{ id: string; name: string; role: string; department_id: string }>).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    department: deptMap.get(a.department_id) || '',
  }));

  // Build per-agent task stats
  const agentStatsMap = new Map<string, { agentId: string; agentName: string; total: number; failed: number }>();
  for (const task of (taskStatsResult.data || []) as Array<{ agent_id: string; status: string }>) {
    const agent = agents.find((a) => a.id === task.agent_id);
    const existing = agentStatsMap.get(task.agent_id) || {
      agentId: task.agent_id,
      agentName: agent?.name || 'Unknown',
      total: 0,
      failed: 0,
    };
    existing.total++;
    if (task.status === 'failed') existing.failed++;
    agentStatsMap.set(task.agent_id, existing);
  }

  // Local runtime uses static recommended roles instead of DB presets
  const presets = (BUSINESS_TYPE_RECOMMENDED_ROLES[businessType] || []).map((r, i) => ({
    presetId: `local-${i}`,
    agentRole: r.role,
    departmentName: r.department,
    businessType,
  }));

  const input: GapAnalysisInput = {
    workspaceId,
    businessType,
    growthStage,
    agents,
    departments,
    taskStats: {
      byAgent: Array.from(agentStatsMap.values()),
      fallbackCount: ((fallbackTasksResult.data || []) as Array<{ id: string; metadata?: string }>)
        .filter((t) => {
          if (!t.metadata) return false;
          try {
            const meta = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : t.metadata;
            return meta?.fallback_assignment === true;
          } catch { return false; }
        }).length,
      failedTaskTitles: ((failedTasksResult.data || []) as Array<{ title: string }>).map((t) => t.title),
    },
    goals: ((goalsResult.data || []) as Array<{ title: string; target_metric: string | null; status: string }>).map((g) => ({
      title: g.title,
      targetMetric: g.target_metric,
      status: g.status,
    })),
    presets,
    existingSuggestionRoles: ((existingSuggestionsResult.data || []) as Array<{ suggested_role: string }>).map(
      (s) => s.suggested_role,
    ),
    focusAreas: GROWTH_STAGE_FOCUS[growthStage] || [],
  };

  return analyzeAgentGaps(input);
}

/**
 * Persist suggestions to the local database.
 */
export async function saveLocalSuggestions(
  db: DatabaseAdapter,
  workspaceId: string,
  suggestions: AgentSuggestion[],
): Promise<void> {
  for (const s of suggestions) {
    await db.from('agent_workforce_agent_suggestions').insert({
      workspace_id: workspaceId,
      gap_type: s.gapType,
      title: s.title,
      reason: s.reason,
      suggested_role: s.suggestedRole,
      suggested_department: s.suggestedDepartment || null,
      preset_id: s.presetId || null,
      evidence: JSON.stringify(s.evidence),
    });
  }
}
