/**
 * Orchestrator tool: get_agent_suggestions (Local)
 * Returns gap analysis suggestions for expanding the AI team.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { runLocalGapAnalysis, saveLocalSuggestions } from '../../planning/agent-gap-analyzer.js';

export const AGENT_SUGGESTIONS_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'get_agent_suggestions',
    description:
      'Analyze the workspace for capability gaps and suggest new agents. If refresh is true, runs a fresh analysis; otherwise returns cached suggestions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        refresh: { type: 'boolean', description: 'Run fresh analysis (default false, returns cached)' },
      },
      required: [],
    },
  },
];

export async function getAgentSuggestions(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const refresh = input.refresh === true;

  if (refresh) {
    const suggestions = await runLocalGapAnalysis(ctx.db, ctx.workspaceId);
    if (suggestions.length > 0) {
      await saveLocalSuggestions(ctx.db, ctx.workspaceId, suggestions);
    }
  }

  // Fetch active suggestions
  const { data, error } = await ctx.db
    .from('agent_workforce_agent_suggestions')
    .select('id, gap_type, title, reason, suggested_role, suggested_department, preset_id, evidence, status, created_at')
    .eq('workspace_id', ctx.workspaceId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return { success: false, error: error.message };

  const suggestions = ((data || []) as Array<Record<string, unknown>>).map((s) => ({
    id: s.id,
    gapType: s.gap_type,
    title: s.title,
    reason: s.reason,
    suggestedRole: s.suggested_role,
    suggestedDepartment: s.suggested_department,
    presetId: s.preset_id,
    evidence: typeof s.evidence === 'string' ? JSON.parse(s.evidence as string) : s.evidence,
    createdAt: s.created_at,
  }));

  if (suggestions.length === 0) {
    return {
      success: true,
      data: { message: 'No team gaps detected right now. Your agent lineup looks solid.', suggestions: [] },
    };
  }

  return {
    success: true,
    data: {
      message: `Found ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'} for strengthening your team.`,
      suggestions,
    },
  };
}
