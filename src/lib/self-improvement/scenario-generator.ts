/**
 * Scenario Generator (E25) — Generate Synthetic Task Variants
 *
 * Takes successful task history and uses LLM to generate
 * variant scenarios for practice.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import type { TrainingScenario } from './types.js';
import { callLLM, parseJSONResponse } from './llm-helper.js';
import { logger } from '../logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const SCENARIOS_PER_TASK = 2;
const MAX_SOURCE_TASKS = 3;

// ============================================================================
// PROMPTS
// ============================================================================

const SCENARIO_SYSTEM_PROMPT = `You generate synthetic training scenarios for an AI agent. Given a successfully completed task, create variant scenarios for practice.

Respond with ONLY a JSON array of objects:
[{
  "title": "scenario title",
  "description": "detailed task description/input",
  "expectedOutcome": "what success looks like",
  "variation": "similar" | "harder" | "edge_case"
}]

Rules:
- Generate exactly 2 scenarios per source task
- One should be "similar" (same type, different details)
- One should be "harder" or "edge_case" (more complex or unusual)
- Make scenarios realistic and specific
- Include enough detail for the agent to attempt the task`;

function buildScenarioPrompt(task: { title: string; description: string; output: string }): string {
  return `Successfully completed task:
Title: ${task.title}
Description: ${task.description}
Output summary: ${typeof task.output === 'string' ? task.output.slice(0, 500) : JSON.stringify(task.output).slice(0, 500)}

Generate 2 training scenarios based on this task.`;
}

// ============================================================================
// MAIN GENERATOR
// ============================================================================

/**
 * Generate training scenarios from an agent's successful task history.
 */
export async function generateScenarios(
  db: DatabaseAdapter,
  router: ModelRouter,
  workspaceId: string,
  agentId: string
): Promise<TrainingScenario[]> {
  const { data: tasks } = await db
    .from('agent_workforce_tasks')
    .select('id, title, description, output')
    .eq('workspace_id', workspaceId)
    .eq('agent_id', agentId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(MAX_SOURCE_TASKS);

  if (!tasks || tasks.length === 0) {
    logger.debug({ agentId }, '[ScenarioGen] No completed tasks for scenario generation');
    return [];
  }

  const scenarios: TrainingScenario[] = [];

  for (const task of tasks) {
    const row = task as Record<string, unknown>;
    try {
      const result = await callLLM(router, {
        system: SCENARIO_SYSTEM_PROMPT,
        userMessage: buildScenarioPrompt({
          title: row.title as string,
          description: (row.description as string) || '',
          output: row.output as string,
        }),
        maxTokens: 500,
        temperature: 0.6,
      });

      if (!result.success) continue;

      const parsed = parseJSONResponse<Array<{ title: string; description: string; expectedOutcome: string; variation: string }>>(result.content);

      if (Array.isArray(parsed)) {
        for (const item of parsed.slice(0, SCENARIOS_PER_TASK)) {
          if (item.title && item.description) {
            const variation = ['similar', 'harder', 'edge_case'].includes(item.variation)
              ? item.variation as TrainingScenario['variation']
              : 'similar';
            scenarios.push({
              title: item.title,
              description: item.description,
              expectedOutcome: item.expectedOutcome || '',
              sourceTaskId: row.id as string,
              variation,
            });
          }
        }
      }
    } catch (err) {
      logger.error({ err, taskId: row.id }, '[ScenarioGen] Scenario generation failed');
    }
  }

  logger.info(
    { agentId, sourceTasks: tasks.length, scenariosGenerated: scenarios.length },
    '[ScenarioGen] Scenario generation completed',
  );

  return scenarios;
}
