/**
 * Observation Layer orchestrator tools (local runtime).
 * Phase 5 of Center of Operations.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { ObservationEngine } from '../../hexis/observation-engine.js';

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'string') { try { return JSON.parse(raw) as T; } catch { return fallback; } }
  return raw as T;
}

export async function getWorkPatterns(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personId = input.person_id as string;
  if (!personId) return { success: false, error: 'person_id is required' };

  // Check if we have a recent pattern map (< 30 min)
  const { data: person } = await ctx.db
    .from('agent_workforce_person_models')
    .select('work_pattern_map')
    .eq('id', personId)
    .single();

  if (person?.work_pattern_map) {
    const existing = parseJson<Record<string, unknown>>(person.work_pattern_map, {});
    const computedAt = existing.computedAt as string;
    if (computedAt) {
      const age = Date.now() - new Date(computedAt).getTime();
      if (age < 30 * 60_000) {
        return {
          success: true,
          data: {
            message: 'Work pattern map (cached, computed recently).',
            patternMap: existing,
            cached: true,
          },
        };
      }
    }
  }

  const engine = new ObservationEngine(ctx.db, ctx.workspaceId);
  const patternMap = await engine.computeWorkPatternMap(personId);
  if (!patternMap) return { success: false, error: 'Person not found' };

  return {
    success: true,
    data: {
      message: `Work patterns computed. ${patternMap.insights.length} insight${patternMap.insights.length !== 1 ? 's' : ''} generated.`,
      patternMap,
      cached: false,
    },
  };
}

export async function getTimeAllocation(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personId = input.person_id as string;
  if (!personId) return { success: false, error: 'person_id is required' };

  const engine = new ObservationEngine(ctx.db, ctx.workspaceId);
  const allocation = await engine.computeTimeAllocation(personId);

  const total = allocation.totalTrackedHours;
  const breakdown = total > 0
    ? `Deep work ${Math.round(allocation.deepWorkHours / total * 100)}%, Communication ${Math.round(allocation.communicationHours / total * 100)}%, Meetings ${Math.round(allocation.meetingHours / total * 100)}%, Approvals ${Math.round(allocation.approvalHours / total * 100)}%, Ops ${Math.round(allocation.operationsHours / total * 100)}%`
    : 'No tracked time this week.';

  return {
    success: true,
    data: {
      message: `${total}h tracked this week. ${breakdown}`,
      allocation,
    },
  };
}

export async function detectAutomationOpportunities(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const engine = new ObservationEngine(ctx.db, ctx.workspaceId);
  const opportunities = await engine.detectAutomationOpportunities();

  if (opportunities.length === 0) {
    return {
      success: true,
      data: {
        message: 'No new automation opportunities detected. All recurring patterns are already tracked.',
        opportunities: [],
      },
    };
  }

  return {
    success: true,
    data: {
      message: `${opportunities.length} automation opportunit${opportunities.length !== 1 ? 'ies' : 'y'} found.`,
      opportunities,
    },
  };
}

export async function getObservationInsights(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personId = input.person_id as string;
  if (!personId) return { success: false, error: 'person_id is required' };

  // Get or compute pattern map
  const engine = new ObservationEngine(ctx.db, ctx.workspaceId);
  const patternMap = await engine.computeWorkPatternMap(personId);
  if (!patternMap) return { success: false, error: 'Person not found' };

  const critical = patternMap.insights.filter((i) => i.severity === 'critical');
  const warnings = patternMap.insights.filter((i) => i.severity === 'warning');
  const info = patternMap.insights.filter((i) => i.severity === 'info');

  return {
    success: true,
    data: {
      message: `${patternMap.insights.length} insight${patternMap.insights.length !== 1 ? 's' : ''}${critical.length > 0 ? ` (${critical.length} critical)` : ''}${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length !== 1 ? 's' : ''})` : ''}.`,
      insights: patternMap.insights,
      summary: {
        totalTrackedHours: patternMap.timeAllocation.totalTrackedHours,
        automationCoverage: patternMap.automationAdoption.automationCoverage,
        dailyMessageVolume: patternMap.communication.dailyMessageVolume,
      },
    },
  };
}
