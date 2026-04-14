/**
 * Co-Evolution Tool Handler
 *
 * Handles the `evolve_task` orchestrator tool:
 * 1. Loads available agents
 * 2. Runs co-evolution across multiple rounds
 * 3. Returns the best deliverable
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import Anthropic from '@anthropic-ai/sdk';

export const CO_EVOLUTION_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'evolve_task',
    description:
      'Run a co-evolution session: multiple agents independently attempt the same task across multiple rounds, each building on the best prior attempts and scored by an evaluator. Use this instead of run_agent when the user asks to "evolve", "iterate", "refine", "improve", or "optimize" something, OR when the task is creative/strategic (strategy, positioning, writing, proposals, pitches, analysis) and would benefit from diverse expert perspectives competing to produce the best version. Returns the highest-scoring deliverable.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'The task or objective for agents to co-evolve a solution for' },
        agent_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: specific agent IDs to include (min 2). If omitted, active agents are selected automatically.',
        },
        max_rounds: {
          type: 'number',
          description: 'Maximum evolution rounds (default 3). More rounds = higher quality but more cost.',
        },
      },
      required: ['prompt'],
    },
  },
];
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { executeLocalCoEvolution } from '../co-evolution/co-evolution-executor.js';
import type { CoEvolutionProgressEvent } from '../co-evolution/co-evolution-executor.js';
import type { OrchestratorEvent } from '../orchestrator-types.js';
import { logger } from '../../lib/logger.js';

/**
 * Run a co-evolution session: multiple agents iterate on the same deliverable.
 */
export async function evolveTask(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  return evolveTaskWithEvents(ctx, input);
}

/**
 * Run co-evolution with event emission for TUI progress display.
 */
export async function evolveTaskWithEvents(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
  onEvent?: (event: OrchestratorEvent) => void,
): Promise<ToolResult> {
  const prompt = input.prompt as string;
  const agentIds = input.agent_ids as string[] | undefined;
  const maxRounds = (input.max_rounds as number | undefined) ?? 3;

  if (!prompt) {
    return { success: false, error: 'prompt is required' };
  }

  // Load available agents
  const query = ctx.db
    .from('agent_workforce_agents')
    .select('id, name, role, status')
    .eq('workspace_id', ctx.workspaceId)
    .eq('status', 'active');

  const { data: agentsRaw } = agentIds && agentIds.length > 0
    ? await query.in('id', agentIds)
    : await query;

  if (!agentsRaw || agentsRaw.length < 2) {
    return {
      success: false,
      error: 'At least 2 active agents are needed for co-evolution. Use run_agent for single-agent tasks.',
    };
  }

  const agents = agentsRaw as Array<{ id: string; name: string; role: string }>;

  logger.info(
    { agents: agents.length, maxRounds, prompt: prompt.slice(0, 100) },
    '[CoEvolution] Starting co-evolution',
  );

  try {
    const selectedIds = agents.map((a) => a.id).slice(0, 4);

    // Emit evolution_start event
    onEvent?.({
      type: 'evolution_start',
      runId: '',
      objective: prompt,
      agents: selectedIds.map((id) => ({ id, name: agents.find((a) => a.id === id)?.name ?? 'Agent' })),
      maxRounds,
    });

    const result = await executeLocalCoEvolution({
      db: ctx.db,
      engine: ctx.engine,
      workspaceId: ctx.workspaceId,
      config: {
        objective: prompt,
        agentIds: selectedIds,
        maxRounds,
      },
      anthropic: ctx.anthropicApiKey ? new Anthropic({ apiKey: ctx.anthropicApiKey }) : undefined,
      modelRouter: ctx.modelRouter ?? undefined,
      onEvent: onEvent ? (event) => {
        // Forward co-evolution events as OrchestratorEvents
        onEvent(event as unknown as OrchestratorEvent);
      } : undefined,
    });

    if (!result.bestAttempt) {
      return {
        success: false,
        error: 'Co-evolution produced no successful attempts.',
      };
    }

    return {
      success: true,
      data: {
        message: `Co-evolution completed. ${result.totalAttempts} attempts across ${result.totalRounds} rounds. Best score: ${result.bestScore?.toFixed(3)}.`,
        bestDeliverable: result.bestAttempt.deliverable,
        bestScore: result.bestScore,
        bestAgentName: result.bestAttempt.agentName,
        totalRounds: result.totalRounds,
        totalAttempts: result.totalAttempts,
        totalCostCents: result.totalCostCents,
        stoppedReason: result.stoppedReason,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Co-evolution failed';
    logger.error({ err }, '[CoEvolution] Execution failed');
    return { success: false, error: msg };
  }
}
