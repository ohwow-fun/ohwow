/**
 * MCTS Tool Planner (E23) — Tree-Search Planning for Tool Selection
 *
 * Activates when stagnation is detected (3 identical tool call hashes)
 * or at iteration midpoint. Uses UCB1 selection + LLM expansion/evaluation
 * to find better tool call strategies.
 */

import type { ModelRouter } from '../../execution/model-router.js';
import type { CandidateAction, PlannerConfig, PlannerResult } from './types.js';
import { DEFAULT_PLANNER_CONFIG } from './types.js';
import { callLLM, parseJSONResponse, calculateCostCents } from './llm-helper.js';
import { logger } from '../logger.js';

// ============================================================================
// EXPANSION PROMPT
// ============================================================================

const EXPANSION_SYSTEM_PROMPT = `You are a tool planning system. Given a task that is stalling, suggest alternative tool calls that could make progress.

Respond with ONLY a JSON array of objects:
[{
  "toolName": "tool_name",
  "description": "what this action does",
  "reasoning": "why this might help",
  "suggestedInput": "high-level input description"
}]

Rules:
- Suggest exactly 3 different tool actions
- Prioritize actions that break out of the current pattern
- Consider tools that gather more information if direct approaches are failing
- Each action should be meaningfully different from the others`;

function buildExpansionPrompt(taskDescription: string, recentContext: string, availableTools: string[]): string {
  return `Task: ${taskDescription}

The agent is stuck. Recent tool calls have been repeating or not making progress.

Recent context:
${recentContext}

Available tools: ${availableTools.join(', ')}

Suggest 3 alternative tool actions to try.`;
}

// ============================================================================
// EVALUATION
// ============================================================================

const EVALUATION_SYSTEM_PROMPT = `You evaluate how much progress a proposed tool action would make toward completing a task.

Score from 0.0 to 1.0 where:
- 0.0 = action makes no progress or is counterproductive
- 0.3 = action is tangentially related
- 0.5 = action makes moderate progress
- 0.7 = action makes significant progress
- 1.0 = action directly completes the task

Respond with ONLY a JSON object: {"score": 0.0, "reasoning": "brief explanation"}`;

function buildEvaluationPrompt(taskDescription: string, recentContext: string, action: CandidateAction): string {
  return `Task: ${taskDescription}

Recent context:
${recentContext}

Proposed action:
- Tool: ${action.toolName}
- Description: ${action.description}
- Input: ${action.suggestedInput}

How much progress would this action make?`;
}

async function evaluateAction(
  router: ModelRouter,
  taskDescription: string,
  recentContext: string,
  action: CandidateAction
): Promise<{ score: number; inputTokens: number; outputTokens: number }> {
  const result = await callLLM(router, {
    system: EVALUATION_SYSTEM_PROMPT,
    userMessage: buildEvaluationPrompt(taskDescription, recentContext, action),
    maxTokens: 100,
    temperature: 0.2,
  });

  if (!result.success) {
    return { score: 0.5, inputTokens: 0, outputTokens: 0 };
  }

  let score = 0.5;
  const parsed = parseJSONResponse<{ score: number }>(result.content);
  if (parsed) {
    score = Math.max(0, Math.min(1, parsed.score));
  }

  return { score, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

// ============================================================================
// UCB1 SELECTION
// ============================================================================

function ucb1Score(avgValue: number, visits: number, totalParentVisits: number, explorationConstant: number): number {
  if (visits === 0) return Infinity;
  return avgValue + explorationConstant * Math.sqrt(Math.log(totalParentVisits) / visits);
}

// ============================================================================
// MAIN PLANNER
// ============================================================================

/**
 * Run MCTS planning step.
 */
export async function runMCTSPlanning(
  router: ModelRouter,
  taskDescription: string,
  recentContext: string,
  availableTools: string[],
  config: PlannerConfig = DEFAULT_PLANNER_CONFIG
): Promise<PlannerResult> {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let llmCalls = 0;

  // Step 1: EXPAND
  const expansionResult = await callLLM(router, {
    system: EXPANSION_SYSTEM_PROMPT,
    userMessage: buildExpansionPrompt(taskDescription, recentContext, availableTools),
    maxTokens: 500,
    temperature: 0.5,
  });

  llmCalls++;
  totalInputTokens += expansionResult.inputTokens;
  totalOutputTokens += expansionResult.outputTokens;

  if (!expansionResult.success) {
    logger.error({ error: expansionResult.error }, '[MCTSPlanner] Expansion failed');
    return {
      selectedAction: { toolName: '', description: '', reasoning: 'Planner expansion failed', suggestedInput: '' },
      candidates: [], activated: false, tokensUsed: 0, costCents: 0,
    };
  }

  const parsed = parseJSONResponse<Array<Record<string, unknown>>>(expansionResult.content);
  let candidates: CandidateAction[] = [];

  if (Array.isArray(parsed)) {
    candidates = parsed
      .filter((item) => item && typeof item.toolName === 'string' && typeof item.description === 'string')
      .slice(0, config.branchingFactor)
      .map((item) => ({
        toolName: item.toolName as string,
        description: item.description as string,
        reasoning: (item.reasoning as string) || '',
        suggestedInput: (item.suggestedInput as string) || '',
      }));
  }

  if (candidates.length === 0) {
    return {
      selectedAction: { toolName: '', description: '', reasoning: 'No candidates', suggestedInput: '' },
      candidates: [], activated: false,
      tokensUsed: totalInputTokens + totalOutputTokens,
      costCents: calculateCostCents(totalInputTokens, totalOutputTokens),
    };
  }

  // Step 2: EVALUATE
  const scored: Array<{ action: CandidateAction; score: number; visits: number }> = [];

  for (const action of candidates) {
    if (llmCalls >= config.maxHaikuCalls) {
      scored.push({ action, score: 0.5, visits: 0 });
      continue;
    }

    const evalResult = await evaluateAction(router, taskDescription, recentContext, action);
    llmCalls++;
    totalInputTokens += evalResult.inputTokens;
    totalOutputTokens += evalResult.outputTokens;
    scored.push({ action, score: evalResult.score, visits: 1 });
  }

  // Step 3: SELECT (UCB1)
  const totalVisits = scored.reduce((sum, c) => sum + c.visits, 0) || 1;
  let bestIndex = 0;
  let bestUCB = -1;

  for (let i = 0; i < scored.length; i++) {
    const ucb = ucb1Score(scored[i].score, scored[i].visits, totalVisits, config.explorationConstant);
    if (ucb > bestUCB) {
      bestUCB = ucb;
      bestIndex = i;
    }
  }

  const costCents = calculateCostCents(totalInputTokens, totalOutputTokens);

  logger.info(
    { selectedTool: scored[bestIndex].action.toolName, score: scored[bestIndex].score.toFixed(3), candidateCount: scored.length, costCents },
    '[MCTSPlanner] Planning step completed',
  );

  return {
    selectedAction: scored[bestIndex].action,
    candidates: scored,
    activated: true,
    tokensUsed: totalInputTokens + totalOutputTokens,
    costCents,
  };
}

/**
 * Determine whether the planner should activate.
 */
export function shouldActivatePlanner(
  toolCallHashes: string[],
  currentIteration: number,
  maxIterations: number
): boolean {
  if (toolCallHashes.length >= 3) {
    const last = toolCallHashes[toolCallHashes.length - 1];
    const window = toolCallHashes.slice(-3);
    if (window.every((h) => h === last)) return true;
  }

  if (maxIterations > 0 && currentIteration >= Math.floor(maxIterations / 2)) return true;

  return false;
}
