/**
 * Collective Intelligence orchestrator tools (local runtime).
 * Phase 6 (capstone) of Center of Operations.
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { CollectiveIntelligenceEngine } from '../../hexis/collective-intelligence.js';

export const COLLECTIVE_INTELLIGENCE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'get_cross_pollination',
    description: 'Find knowledge transfer opportunities across people and agents. Detects when someone excels at a skill another person is trying to develop.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'schedule_team_council',
    description: 'Suggest data-enriched council topics from current team state: workload imbalances, growth concerns, operational gaps, strategy questions.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_collective_briefing',
    description: 'Assemble a collective intelligence briefing for a person: team growth trends, cross-pollination suggestions, workload alerts, council insights, team capacity.',
    input_schema: {
      type: 'object' as const,
      properties: {
        person_id: { type: 'string', description: 'Person model ID' },
      },
      required: ['person_id'],
    },
  },
  {
    name: 'rebalance_workload',
    description: 'Analyze team workload and suggest rebalancing. Identifies overloaded people with tasks that agents could handle. Shows team capacity and headroom.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
];

export async function getCrossPollination(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const engine = new CollectiveIntelligenceEngine(ctx.db, ctx.workspaceId);
  const suggestions = await engine.findCrossPollinationOpportunities();

  if (suggestions.length === 0) {
    return {
      success: true,
      data: {
        message: 'No cross-pollination opportunities found yet. Need more completed tasks with quality scores across different people.',
        suggestions: [],
      },
    };
  }

  return {
    success: true,
    data: {
      message: `${suggestions.length} knowledge transfer opportunit${suggestions.length !== 1 ? 'ies' : 'y'} found.`,
      suggestions,
    },
  };
}

export async function scheduleTeamCouncil(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const engine = new CollectiveIntelligenceEngine(ctx.db, ctx.workspaceId);
  const topics = await engine.suggestCouncilTopics();

  if (topics.length === 0) {
    return {
      success: true,
      data: {
        message: 'No urgent council topics detected. Team state looks stable.',
        topics: [],
      },
    };
  }

  return {
    success: true,
    data: {
      message: `${topics.length} council topic${topics.length !== 1 ? 's' : ''} suggested. Top: "${topics[0].topic}" (${topics[0].urgency} urgency).`,
      topics,
    },
  };
}

export async function getCollectiveBriefing(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const personId = input.person_id as string;
  if (!personId) return { success: false, error: 'person_id is required' };

  const engine = new CollectiveIntelligenceEngine(ctx.db, ctx.workspaceId);
  const briefing = await engine.assembleCollectiveBriefing(personId);

  const alerts = briefing.workloadAlerts.length;
  const pollinations = briefing.crossPollination.length;

  return {
    success: true,
    data: {
      message: `Team: ${briefing.teamGrowth.ascending} growing, ${briefing.teamGrowth.declining} declining. ${pollinations} knowledge transfer${pollinations !== 1 ? 's' : ''} available. ${alerts} alert${alerts !== 1 ? 's' : ''}.`,
      briefing,
    },
  };
}

export async function rebalanceWorkload(
  ctx: LocalToolContext,
): Promise<ToolResult> {
  const engine = new CollectiveIntelligenceEngine(ctx.db, ctx.workspaceId);
  const [suggestions, capacity] = await Promise.all([
    engine.suggestRebalancing(),
    engine.getTeamCapacity(),
  ]);

  if (suggestions.length === 0) {
    return {
      success: true,
      data: {
        message: `Workload looks balanced. ${capacity.headroomPercent}% capacity headroom. ${capacity.totalPeople} people, ${capacity.totalAgents} agents.`,
        suggestions: [],
        capacity,
      },
    };
  }

  return {
    success: true,
    data: {
      message: `${suggestions.length} rebalancing suggestion${suggestions.length !== 1 ? 's' : ''}. ${capacity.overloadedPeople.length} overloaded, ${capacity.underutilizedAgents.length} underutilized.`,
      suggestions,
      capacity,
    },
  };
}
