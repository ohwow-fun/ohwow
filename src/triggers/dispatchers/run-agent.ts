/**
 * run_agent dispatcher: create a task and fire-and-forget execute it.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export const runAgentDispatcher: ActionDispatcher = {
  actionType: 'run_agent',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
    trigger: LocalTrigger,
  ): Promise<ActionOutput> {
    const agentId = config.agent_id as string;
    // The schema + every writer stores the agent instruction under `task_prompt`
    // (see src/triggers/action-config-schemas.ts and automation-service). Reading
    // only `config.prompt` dropped the real prompt on every fire and fell back
    // to the generic stub, which made scheduled automations look like they ran
    // but produced hollow output.
    const promptTemplate = (config.task_prompt as string) || (config.prompt as string) || `Handle ${trigger.name} event`;

    if (!agentId) {
      throw new Error('run_agent action requires agent_id in action_config');
    }

    const prompt = resolveContextTemplate(promptTemplate, context);

    const { data: taskData } = await deps.db.from('agent_workforce_tasks')
      .insert({
        workspace_id: deps.workspaceId,
        agent_id: agentId,
        title: `[Trigger] ${trigger.name}`,
        input: prompt,
        status: 'pending',
        priority: 'normal',
        // Back-link for the trigger watchdog. The finalization hooks
        // read this column and aggregate the outcome into the trigger's
        // consecutive_failures / last_succeeded_at so silent cron
        // failures surface as a trigger_stuck activity after N runs.
        source_trigger_id: trigger.id,
      })
      .select('id')
      .single();

    if (taskData) {
      const taskId = (taskData as { id: string }).id;
      deps.engine.executeTask(agentId, taskId).catch((err) => {
        logger.error(`[ActionExecutor] Task execution failed for trigger ${trigger.id}: ${err}`);
      });

      return { task_id: taskId, agent_id: agentId, status: 'dispatched' };
    }

    return { task_id: null, agent_id: agentId, status: 'no_task_created' };
  },
};
