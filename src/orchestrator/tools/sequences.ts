/**
 * Sequential Multi-Agent Tool Handler
 *
 * Handles the `run_sequence` orchestrator tool:
 * 1. Loads available agents
 * 2. Checks if Sequential coordination is warranted
 * 3. Decomposes the prompt into a SequenceDefinition
 * 4. Executes the sequence and returns the merged result
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import type { SequenceEvent } from '../sequential/types.js';
import { shouldSequence } from '../sequential/should-sequence.js';
import { decomposeIntoSequence } from '../sequential/sequence-decomposer.js';
import { executeSequence } from '../sequential/sequential-executor.js';
import { logger } from '../../lib/logger.js';

/**
 * Run a Sequential multi-agent chain.
 * Falls back to single-agent run_agent if Sequential is not warranted.
 */
export async function runSequence(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const prompt = input.prompt as string;
  const agentIds = input.agent_ids as string[] | undefined;

  if (!prompt) {
    return { success: false, error: 'prompt is required' };
  }

  // Load available agents
  const query = ctx.db
    .from('agent_workforce_agents')
    .select('id, name, role, config, status')
    .eq('workspace_id', ctx.workspaceId)
    .eq('status', 'active');

  const { data: agentsRaw } = agentIds && agentIds.length > 0
    ? await query.in('id', agentIds)
    : await query;

  if (!agentsRaw || agentsRaw.length === 0) {
    return { success: false, error: 'No active agents found in workspace' };
  }

  const agents = agentsRaw as Array<{ id: string; name: string; role: string; config: string | Record<string, unknown>; status: string }>;

  // Check if Sequential is warranted
  const check = shouldSequence({
    prompt,
    agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
  });

  if (!check.shouldSequence) {
    // Fall back: suggest using run_agent with the most relevant agent
    return {
      success: true,
      data: {
        message: `Sequential not needed: ${check.reason}. Use run_agent instead with one of the available agents.`,
        agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
        fallbackReason: check.reason,
      },
    };
  }

  // Decompose into a sequence
  const definition = await decomposeIntoSequence({
    prompt,
    agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
    anthropic: ctx.anthropicApiKey ? new Anthropic({ apiKey: ctx.anthropicApiKey }) : undefined,
    modelRouter: ctx.modelRouter ?? undefined,
  });

  if (!definition) {
    return {
      success: false,
      error: 'Could not decompose task into a multi-agent sequence. Try using run_agent with a single agent instead.',
    };
  }

  logger.info(
    { name: definition.name, steps: definition.steps.length, agents: definition.steps.map((s) => s.agentId) },
    'Executing Sequential chain'
  );

  // Execute the sequence
  try {
    const result = await executeSequence({
      db: ctx.db,
      engine: ctx.engine,
      workspaceId: ctx.workspaceId,
      definition,
      anthropic: ctx.anthropicApiKey ? new Anthropic({ apiKey: ctx.anthropicApiKey }) : undefined,
      modelRouter: ctx.modelRouter ?? undefined,
    });

    if (!result.success) {
      return {
        success: false,
        error: `Sequence "${definition.name}" failed. ${result.stepResults.filter((r) => r.error).map((r) => r.error).join('; ')}`,
      };
    }

    return {
      success: true,
      data: {
        message: `Sequence "${definition.name}" completed. ${result.participatedCount} agents contributed, ${result.abstainedCount} abstained.`,
        finalOutput: result.finalOutput,
        steps: result.stepResults.map((r) => ({
          stepId: r.stepId,
          agentId: r.agentId,
          status: r.status,
          durationMs: r.durationMs,
          costCents: r.costCents,
        })),
        totalCostCents: result.totalCostCents,
        totalDurationMs: result.totalDurationMs,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sequence execution failed';
    logger.error({ err }, 'Sequential chain execution failed');
    return { success: false, error: msg };
  }
}

/**
 * Run a Sequential chain with event emission for TUI progress display.
 * Called from tool-executor.ts special case.
 */
export async function runSequenceWithEvents(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
  onEvent: (event: SequenceEvent) => void,
): Promise<ToolResult> {
  const prompt = input.prompt as string;
  const agentIds = input.agent_ids as string[] | undefined;

  if (!prompt) return { success: false, error: 'prompt is required' };

  const query = ctx.db
    .from('agent_workforce_agents')
    .select('id, name, role, config, status')
    .eq('workspace_id', ctx.workspaceId)
    .eq('status', 'active');

  const { data: agentsRaw } = agentIds && agentIds.length > 0
    ? await query.in('id', agentIds)
    : await query;

  if (!agentsRaw || agentsRaw.length === 0) {
    return { success: false, error: 'No active agents found in workspace' };
  }

  const agents = agentsRaw as Array<{ id: string; name: string; role: string; config: string | Record<string, unknown> }>;

  const check = shouldSequence({
    prompt,
    agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
  });

  if (!check.shouldSequence) {
    return {
      success: true,
      data: {
        message: `Sequential not needed: ${check.reason}. Use run_agent instead.`,
        agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
        fallbackReason: check.reason,
      },
    };
  }

  const definition = await decomposeIntoSequence({
    prompt,
    agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
    anthropic: ctx.anthropicApiKey ? new Anthropic({ apiKey: ctx.anthropicApiKey }) : undefined,
    modelRouter: ctx.modelRouter ?? undefined,
  });

  if (!definition) {
    return { success: false, error: 'Could not decompose task into a multi-agent sequence.' };
  }

  try {
    const result = await executeSequence({
      db: ctx.db,
      engine: ctx.engine,
      workspaceId: ctx.workspaceId,
      definition,
      onEvent,
      anthropic: ctx.anthropicApiKey ? new Anthropic({ apiKey: ctx.anthropicApiKey }) : undefined,
      modelRouter: ctx.modelRouter ?? undefined,
    });

    if (!result.success) {
      return {
        success: false,
        error: `Sequence "${definition.name}" failed. ${result.stepResults.filter((r) => r.error).map((r) => r.error).join('; ')}`,
      };
    }

    return {
      success: true,
      data: {
        message: `Sequence "${definition.name}" completed. ${result.participatedCount} agents contributed, ${result.abstainedCount} abstained.`,
        finalOutput: result.finalOutput,
        totalCostCents: result.totalCostCents,
        totalDurationMs: result.totalDurationMs,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sequence execution failed';
    return { success: false, error: msg };
  }
}
