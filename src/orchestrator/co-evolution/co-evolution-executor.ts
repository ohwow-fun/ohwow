/**
 * Co-Evolution Executor — Local Runtime
 *
 * Simplified co-evolution engine for the local ohwow runtime.
 * Uses DatabaseAdapter + RuntimeEngine instead of Supabase.
 *
 * Flow: N agents iterate on the same deliverable across R rounds.
 * Each round, all agents see top K prior attempts and try to improve.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';
import type { ModelRouter } from '../../execution/model-router.js';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../lib/logger.js';
import type {
  LocalCoEvolutionConfig,
  LocalCoEvolutionResult,
  LocalAttemptRecord,
} from './types.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Progress event emitted by the co-evolution loop.
 * The `type` discriminant identifies the phase (e.g. `round_start`, `attempt_done`, `complete`).
 * Additional payload keys vary by event type and are accessed via the index signature.
 */
export interface CoEvolutionProgressEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Options for running a local co-evolution session.
 */
export interface ExecuteLocalCoEvolutionOptions {
  /** DatabaseAdapter for persisting attempts and results. */
  db: DatabaseAdapter;
  /** RuntimeEngine used to execute each agent turn. */
  engine: RuntimeEngine;
  /** Workspace to scope the run. */
  workspaceId: string;
  /** Co-evolution config: agentIds, rounds, topK context window, deliverable spec. */
  config: LocalCoEvolutionConfig;
  /** Optional pre-configured Anthropic SDK client (injected for testing). */
  anthropic?: Anthropic;
  /** Optional model routing override. Pass null to disable routing. */
  modelRouter?: ModelRouter | null;
  /** Optional callback for streaming progress events as the loop runs. */
  onEvent?: (event: CoEvolutionProgressEvent) => void;
}

// ============================================================================
// MAIN EXECUTOR
// ============================================================================

/**
 * Run a local co-evolution session: N agents iterate across R rounds improving
 * a shared deliverable. Each round, every agent sees the top-K prior attempts
 * and tries to produce a better result. Returns a LocalCoEvolutionResult with
 * the best attempt, score summary, total cost, and per-agent metadata.
 *
 * @param options - Session configuration including agents, rounds, and callbacks.
 * @returns The best attempt, scoring breakdown, elapsed time, and total token cost.
 */
export async function executeLocalCoEvolution(
  options: ExecuteLocalCoEvolutionOptions,
): Promise<LocalCoEvolutionResult> {
  const { db, engine, workspaceId, config, anthropic, modelRouter, onEvent } = options;
  const startTime = Date.now();
  const topK = config.topKForContext ?? 3;
  const emit = (event: CoEvolutionProgressEvent) => { if (onEvent) onEvent(event); };

  // Resolve agent names
  const agentNames = new Map<string, string>();
  for (const agentId of config.agentIds) {
    const { data } = await db
      .from('agent_workforce_agents')
      .select('name')
      .eq('id', agentId)
      .single();
    if (data) agentNames.set(agentId, (data as { name: string }).name);
  }

  // Create run record
  let runId: string | undefined;
  try {
    const { data } = await db
      .from('agent_workforce_evolution_runs')
      .insert({
        workspace_id: workspaceId,
        objective: config.objective,
        evaluation_criteria: JSON.stringify([]),
        evaluation_mode: 'llm',
        agent_ids: JSON.stringify(config.agentIds),
        max_rounds: config.maxRounds,
        budget_cents: config.budgetCents ?? null,
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    runId = (data as { id: string } | null)?.id;
  } catch (err) {
    logger.warn({ err }, '[LocalCoEvolution] Couldn\'t create run record');
  }

  // State
  const allAttempts: LocalAttemptRecord[] = [];
  let bestAttempt: LocalAttemptRecord | null = null;
  let bestScore: number | null = null;
  let totalCostCents = 0;
  let consecutiveStagnant = 0;
  let stoppedReason = 'completed';

  for (let round = 0; round < config.maxRounds; round++) {
    const previousBest = bestScore;

    logger.info({ round: round + 1, maxRounds: config.maxRounds }, '[LocalCoEvolution] Starting round');
    emit({ type: 'evolution_round_start', round });

    // Get top K attempts for context
    const contextAttempts = getTopK(allAttempts, topK);

    // Execute all agents in parallel
    const results = await Promise.allSettled(
      config.agentIds.map((agentId) =>
        executeAgentRound({
          db, engine, workspaceId, runId: runId ?? '',
          round, agentId,
          agentName: agentNames.get(agentId) ?? 'Agent',
          objective: config.objective,
          contextAttempts,
          bestScore,
          anthropic, modelRouter,
          evaluationPrompt: config.evaluationPrompt,
        }),
      ),
    );

    for (const settled of results) {
      if (settled.status === 'fulfilled' && settled.value) {
        const attempt = settled.value;
        allAttempts.push(attempt);
        totalCostCents += attempt.costCents;

        if (attempt.status === 'completed') {
          emit({
            type: 'evolution_attempt_complete',
            round, agentId: attempt.agentId, agentName: attempt.agentName,
            score: attempt.score, strategySummary: attempt.strategySummary,
            costCents: attempt.costCents,
          });
          if (bestScore === null || attempt.score > bestScore) {
            bestScore = attempt.score;
            bestAttempt = attempt;
          }
        } else {
          emit({
            type: 'evolution_attempt_failed',
            round, agentId: attempt.agentId, agentName: attempt.agentName,
            error: attempt.error ?? 'Failed',
          });
        }
      }
    }

    emit({
      type: 'evolution_round_complete',
      round, bestScore: bestScore ?? 0, bestAgentName: bestAttempt?.agentName ?? '',
    });

    // Stagnation check
    if (previousBest !== null && (bestScore === null || bestScore <= previousBest)) {
      consecutiveStagnant++;
    } else {
      consecutiveStagnant = 0;
    }

    if (consecutiveStagnant >= 3) {
      stoppedReason = 'consecutive_stagnation';
      break;
    }

    // Budget check
    if (config.budgetCents && totalCostCents >= config.budgetCents) {
      stoppedReason = 'budget_cost';
      break;
    }
  }

  // Update run record
  if (runId) {
    try {
      await db
        .from('agent_workforce_evolution_runs')
        .update({
          status: 'completed',
          best_attempt_id: bestAttempt?.id ?? null,
          best_score: bestScore,
          total_cost_cents: totalCostCents,
          total_attempts: allAttempts.length,
          stopped_reason: stoppedReason,
          completed_at: new Date().toISOString(),
        })
        .eq('id', runId);
    } catch (err) {
      logger.warn({ err }, '[LocalCoEvolution] Couldn\'t update run record');
    }
  }

  return {
    runId: runId ?? '',
    bestAttempt,
    bestScore,
    totalRounds: Math.min(allAttempts.length > 0 ? allAttempts[allAttempts.length - 1].round + 1 : 0, config.maxRounds),
    totalAttempts: allAttempts.length,
    totalCostCents,
    totalDurationMs: Date.now() - startTime,
    stoppedReason,
    attempts: allAttempts,
  };
}

// ============================================================================
// PER-AGENT ROUND
// ============================================================================

interface AgentRoundOptions {
  db: DatabaseAdapter;
  engine: RuntimeEngine;
  workspaceId: string;
  runId: string;
  round: number;
  agentId: string;
  agentName: string;
  objective: string;
  contextAttempts: LocalAttemptRecord[];
  bestScore: number | null;
  anthropic?: Anthropic;
  modelRouter?: ModelRouter | null;
  evaluationPrompt?: string;
}

async function executeAgentRound(options: AgentRoundOptions): Promise<LocalAttemptRecord | null> {
  const {
    db, engine, workspaceId, runId, round, agentId, agentName,
    objective, contextAttempts, bestScore, anthropic, modelRouter,
    evaluationPrompt,
  } = options;

  const attemptStart = Date.now();

  // Pick parent attempt (prefer cross-agent)
  const crossAgent = contextAttempts
    .filter((a) => a.agentId !== agentId)
    .sort((a, b) => b.score - a.score);
  const parentAttempt = crossAgent[0] ?? contextAttempts[0] ?? null;

  // Build task input
  const taskInput = buildLocalEvolutionPrompt(objective, round, agentName, contextAttempts, bestScore);

  // Create task
  let taskId: string;
  try {
    const { data } = await db
      .from('agent_workforce_tasks')
      .insert({
        workspace_id: workspaceId,
        agent_id: agentId,
        title: `[Co-Evolution] Round ${round + 1} — ${agentName}`,
        input: JSON.stringify(taskInput),
        status: 'pending',
        requires_approval: false,
      })
      .select('id')
      .single();

    taskId = (data as { id: string }).id;
  } catch (err) {
    logger.error({ err, agentId, round }, '[LocalCoEvolution] Couldn\'t create task');
    return null;
  }

  // Execute
  try {
    const result = await engine.executeTask(agentId, taskId);

    const outputText = typeof result.output === 'string'
      ? result.output
      : result.output ? JSON.stringify(result.output) : '';

    if (!result.success || !outputText) {
      return null;
    }

    // Extract strategy
    const { strategy, deliverable } = extractStrategy(outputText);

    // Evaluate via LLM
    const score = await evaluateLocally(deliverable, objective, evaluationPrompt, anthropic, modelRouter);
    const durationMs = Date.now() - attemptStart;

    const attemptId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);

    // Record attempt
    try {
      await db
        .from('agent_workforce_evolution_attempts')
        .insert({
          id: attemptId,
          run_id: runId,
          workspace_id: workspaceId,
          round,
          agent_id: agentId,
          parent_attempt_id: parentAttempt?.id ?? null,
          parent_agent_id: parentAttempt?.agentId ?? null,
          deliverable,
          strategy_summary: strategy,
          score,
          cost_cents: result.costCents ?? 0,
          duration_ms: durationMs,
          status: 'completed',
        });
    } catch (err) {
      logger.warn({ err }, '[LocalCoEvolution] Couldn\'t record attempt');
    }

    return {
      id: attemptId,
      round,
      agentId,
      agentName,
      parentAttemptId: parentAttempt?.id ?? null,
      parentAgentId: parentAttempt?.agentId ?? null,
      deliverable,
      strategySummary: strategy,
      score,
      costCents: result.costCents ?? 0,
      durationMs,
      status: 'completed',
    };
  } catch (err) {
    logger.error({ err, agentId, round }, '[LocalCoEvolution] Agent execution failed');
    return null;
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function getTopK(attempts: LocalAttemptRecord[], k: number): LocalAttemptRecord[] {
  return [...attempts]
    .filter((a) => a.status === 'completed')
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function buildLocalEvolutionPrompt(
  objective: string,
  round: number,
  agentName: string,
  contextAttempts: LocalAttemptRecord[],
  bestScore: number | null,
): string {
  const parts: string[] = [];

  parts.push(`## Co-Evolution Mode (Round ${round + 1})`);
  parts.push(`You are ${agentName}, participating in a co-evolution session.${bestScore !== null ? ` Current best score: ${bestScore.toFixed(3)}.` : ''}`);
  parts.push('Start your response with "Strategy: [your approach]" then produce the deliverable.\n');

  if (contextAttempts.length > 0) {
    parts.push('## Prior Attempts\n');
    for (const a of contextAttempts) {
      parts.push(`**${a.agentName}** (Round ${a.round + 1}) | Score: ${a.score.toFixed(3)}`);
      parts.push(`Strategy: ${a.strategySummary}`);
      parts.push(`${a.deliverable.slice(0, 1500)}\n---\n`);
    }
  }

  parts.push(`## Your Task\n\n${objective}`);

  return parts.join('\n');
}

function extractStrategy(output: string): { strategy: string; deliverable: string } {
  const lines = output.split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  const match = firstLine.match(/^strategy:\s*(.+)/i);
  if (match) {
    return { strategy: match[1].trim(), deliverable: lines.slice(1).join('\n').trim() };
  }
  return { strategy: output.slice(0, 150).replace(/\n/g, ' ').trim(), deliverable: output };
}

async function evaluateLocally(
  deliverable: string,
  objective: string,
  evaluationPrompt: string | undefined,
  anthropic?: Anthropic,
  modelRouter?: ModelRouter | null,
): Promise<number> {
  const prompt = evaluationPrompt ?? 'Rate the deliverable on relevance, quality, and actionability.';

  // Try Anthropic first, then model router
  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-20250414',
        max_tokens: 100,
        temperature: 0.1,
        system: `You evaluate deliverables. ${prompt}\nRespond with ONLY a JSON object: {"score": 0.0-1.0}`,
        messages: [{
          role: 'user',
          content: `Objective: ${objective}\n\nDeliverable:\n${deliverable.slice(0, 2000)}`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const parsed = JSON.parse(text.replace(/```json?\s*/g, '').replace(/```/g, '').trim());
      return Math.max(0, Math.min(1, parsed.score ?? 0.5));
    } catch {
      return 0.5;
    }
  }

  if (modelRouter) {
    try {
      const provider = await modelRouter.getProvider('memory_extraction');
      const result = await provider.createMessage({
        system: `You evaluate deliverables. ${prompt}\nRespond with ONLY a JSON object: {"score": 0.0-1.0}`,
        messages: [{
          role: 'user',
          content: `Objective: ${objective}\n\nDeliverable:\n${deliverable.slice(0, 2000)}`,
        }],
        maxTokens: 100,
        temperature: 0.1,
      });

      const parsed = JSON.parse(result.content.replace(/```json?\s*/g, '').replace(/```/g, '').trim());
      return Math.max(0, Math.min(1, parsed.score ?? 0.5));
    } catch {
      return 0.5;
    }
  }

  // No evaluator available — return middle score
  return 0.5;
}
