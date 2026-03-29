/**
 * run_workflow dispatcher: create and execute a workflow run.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextValue } from '../action-utils.js';
import { logger } from '../../lib/logger.js';

export const runWorkflowDispatcher: ActionDispatcher = {
  actionType: 'run_workflow',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const workflowId = config.workflow_id as string;
    if (!workflowId) {
      throw new Error('run_workflow requires workflow_id in action_config');
    }

    const variables: Record<string, unknown> = {};
    const variableMapping = config.variable_mapping as Record<string, string> | undefined;
    if (variableMapping) {
      for (const [key, sourcePath] of Object.entries(variableMapping)) {
        variables[key] = resolveContextValue(sourcePath, context);
      }
    }

    const { data: runData } = await deps.db.from('agent_workforce_workflow_runs')
      .insert({
        workspace_id: deps.workspaceId,
        workflow_id: workflowId,
        status: 'pending',
        variables: JSON.stringify(variables),
      })
      .select('id')
      .single();

    const runId = runData ? (runData as { id: string }).id : null;
    logger.info(`[ActionExecutor] Created workflow run ${runId} for workflow ${workflowId}`);
    return { workflow_run_id: runId, status: 'pending' };
  },
};
