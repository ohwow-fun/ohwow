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
    const promptTemplate = (config.prompt as string) || `Handle ${trigger.name} event`;

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
