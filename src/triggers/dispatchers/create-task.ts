/**
 * create_task dispatcher: create a task in a project board, optionally dispatch immediately.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';
import { resolveContextValue } from '../action-utils.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export const createTaskDispatcher: ActionDispatcher = {
  actionType: 'create_task',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
    trigger: LocalTrigger,
  ): Promise<ActionOutput> {
    const projectId = config.project_id as string | undefined;
    const titleTemplate = config.title_template as string;
    const descriptionTemplate = config.description_template as string | undefined;
    const boardColumn = (config.board_column as string) || 'todo';
    const priority = (config.priority as string) || 'normal';
    const agentId = config.agent_id as string | undefined;
    const runImmediately = config.run_immediately === true;
    const contactIdPath = config.contact_id_path as string | undefined;
    const labels = (config.labels as string[]) || [];

    if (!titleTemplate) {
      throw new Error('create_task requires title_template in action_config');
    }

    const title = resolveContextTemplate(titleTemplate, context);
    const description = descriptionTemplate ? resolveContextTemplate(descriptionTemplate, context) : null;

    const contactIds: string[] = [];
    if (contactIdPath) {
      const contactId = resolveContextValue(contactIdPath, context);
      if (contactId && typeof contactId === 'string') {
        contactIds.push(contactId);
      }
    }

    const insertPayload: Record<string, unknown> = {
      workspace_id: deps.workspaceId,
      title,
      description,
      board_column: boardColumn,
      priority,
      status: runImmediately && agentId ? 'in_progress' : 'pending',
      source_type: 'automation',
      contact_ids: contactIds,
      labels,
      ...(projectId ? { project_id: projectId } : {}),
      ...(agentId ? { agent_id: agentId, assignee_type: 'agent' } : {}),
      ...(runImmediately && agentId ? { started_at: new Date().toISOString() } : {}),
    };

    const { data: newTask } = await deps.db.from('agent_workforce_tasks')
      .insert(insertPayload)
      .select('id')
      .single();

    const taskId = newTask ? (newTask as { id: string }).id : null;

    if (runImmediately && agentId && taskId) {
      deps.engine.executeTask(agentId, taskId).catch((err) => {
        logger.error(`[ActionExecutor] create_task agent dispatch failed for trigger ${trigger.id}: ${err}`);
      });
    }

    logger.info(`[ActionExecutor] Created task "${title}" in column ${boardColumn}`);
    return {
      task_id: taskId,
      project_id: projectId ?? null,
      board_column: boardColumn,
      status: insertPayload.status as string,
      agent_id: agentId ?? null,
    };
  },
};
