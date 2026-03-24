/**
 * Practice Evaluator (E25) — Score Sandbox Output and Extract Learnings
 *
 * Scores the agent's sandbox performance and extracts learnings
 * as memories for future improvement.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import type { PracticeRunSummary, TrainingScenario } from './types.js';
import { callLLM, parseJSONResponse, calculateCostCents } from './llm-helper.js';
import { generateScenarios } from './scenario-generator.js';
import { executeSandbox } from './sandbox-executor.js';
import { logger } from '../logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_SESSIONS_PER_AGENT = 2;
const PRACTICE_SKIP_THRESHOLD = 0.8;

// ============================================================================
// VERIFICATION PROMPT
// ============================================================================

const VERIFICATION_SYSTEM_PROMPT = `You evaluate an AI agent's practice session output. Score how well the agent approached the task.

Respond with ONLY a JSON object:
{
  "score": 0.0,
  "learnings": ["learning 1", "learning 2"],
  "strengths": "what went well",
  "improvements": "what could be better"
}

Score from 0.0 to 1.0:
- 0.0-0.3: Poor approach, wrong tools or reasoning
- 0.4-0.6: Adequate but could be more efficient
- 0.7-0.8: Good approach with minor improvements
- 0.9-1.0: Excellent approach and reasoning

Learnings should be actionable insights (max 3).`;

function buildVerificationPrompt(scenario: TrainingScenario, output: string): string {
  return `Scenario: ${scenario.title}
Description: ${scenario.description}
Expected outcome: ${scenario.expectedOutcome}
Variation: ${scenario.variation}

Agent output:
${output}

Evaluate the agent's approach.`;
}

// ============================================================================
// EVALUATION
// ============================================================================

async function evaluateSession(
  router: ModelRouter,
  scenario: TrainingScenario,
  output: string
): Promise<{ score: number; learnings: string[]; inputTokens: number; outputTokens: number }> {
  const result = await callLLM(router, {
    system: VERIFICATION_SYSTEM_PROMPT,
    userMessage: buildVerificationPrompt(scenario, output),
    maxTokens: 300,
    temperature: 0.2,
  });

  if (!result.success) {
    return { score: 0.5, learnings: [], inputTokens: 0, outputTokens: 0 };
  }

  let score = 0.5;
  let learnings: string[] = [];

  const parsed = parseJSONResponse<{ score: number; learnings: string[] }>(result.content);
  if (parsed) {
    score = Math.max(0, Math.min(1, parsed.score));
    learnings = Array.isArray(parsed.learnings) ? parsed.learnings.slice(0, 3) : [];
  }

  return { score, learnings, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

// ============================================================================
// MAIN PRACTICE RUNNER
// ============================================================================

/**
 * Run practice sessions for an agent.
 */
export async function runPracticeSessions(
  db: DatabaseAdapter,
  router: ModelRouter,
  workspaceId: string,
  agentId: string,
  agentSystemPrompt: string,
  currentSuccessRate: number
): Promise<PracticeRunSummary> {
  const summary: PracticeRunSummary = {
    scenariosGenerated: 0,
    sessionsRun: 0,
    sessionsCompleted: 0,
    totalLearnings: 0,
    totalCostCents: 0,
  };

  if (currentSuccessRate >= PRACTICE_SKIP_THRESHOLD) {
    logger.debug({ agentId, successRate: currentSuccessRate }, '[PracticeEvaluator] Agent performing well, skipping practice');
    return summary;
  }

  const scenarios = await generateScenarios(db, router, workspaceId, agentId);
  summary.scenariosGenerated = scenarios.length;
  if (scenarios.length === 0) return summary;

  for (const scenario of scenarios.slice(0, MAX_SESSIONS_PER_AGENT)) {
    // Record session start
    let sessionId = '';
    try {
      const { data: sessionData } = await db
        .from('agent_workforce_practice_sessions')
        .insert({
          workspace_id: workspaceId,
          agent_id: agentId,
          source_task_id: scenario.sourceTaskId,
          scenario: JSON.stringify(scenario),
          status: 'running',
        })
        .select('id')
        .single();
      sessionId = (sessionData as Record<string, unknown>)?.id as string ?? '';
    } catch { /* non-fatal */ }

    try {
      const practiceResult = await executeSandbox(router, scenario, agentSystemPrompt);

      summary.sessionsRun++;
      summary.totalCostCents += practiceResult.costCents;

      const evaluation = await evaluateSession(router, scenario, practiceResult.output);
      summary.totalCostCents += calculateCostCents(evaluation.inputTokens, evaluation.outputTokens);

      practiceResult.verificationScore = evaluation.score;

      // Extract learnings as memories
      for (const learning of evaluation.learnings) {
        try {
          await db
            .from('agent_workforce_agent_memory')
            .insert({
              agent_id: agentId,
              workspace_id: workspaceId,
              memory_type: 'skill',
              content: `[Practice] ${learning}`,
              source_type: 'extraction',
              relevance_score: 0.5,
            });
          practiceResult.learningsExtracted++;
        } catch { /* non-fatal */ }
      }

      summary.totalLearnings += practiceResult.learningsExtracted;

      if (practiceResult.completed) {
        summary.sessionsCompleted++;
      }

      // Update session record
      if (sessionId) {
        await db
          .from('agent_workforce_practice_sessions')
          .update({
            result: JSON.stringify(practiceResult),
            verification_score: evaluation.score,
            learnings_extracted: practiceResult.learningsExtracted,
            cost_cents: practiceResult.costCents + calculateCostCents(evaluation.inputTokens, evaluation.outputTokens),
            status: 'completed',
          })
          .eq('id', sessionId);
      }
    } catch (err) {
      logger.error({ err, agentId, scenario: scenario.title }, '[PracticeEvaluator] Practice session failed');

      if (sessionId) {
        await db
          .from('agent_workforce_practice_sessions')
          .update({ status: 'failed' })
          .eq('id', sessionId);
      }
    }
  }

  logger.info(
    { agentId, sessionsRun: summary.sessionsRun, sessionsCompleted: summary.sessionsCompleted, totalLearnings: summary.totalLearnings, totalCostCents: summary.totalCostCents },
    '[PracticeEvaluator] Practice sessions completed',
  );

  return summary;
}
