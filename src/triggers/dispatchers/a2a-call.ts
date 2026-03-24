/**
 * a2a_call dispatcher: send a task to an external agent via A2A protocol.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import type { DbA2AConnection, A2AMessage } from '../../a2a/types.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export const a2aCallDispatcher: ActionDispatcher = {
  actionType: 'a2a_call',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const connectionId = config.connection_id as string;
    if (!connectionId) {
      throw new Error('a2a_call requires connection_id in action_config');
    }

    const { data: connectionRow } = await deps.db.from('a2a_connections')
      .select('*')
      .eq('id', connectionId)
      .eq('workspace_id', deps.workspaceId)
      .eq('status', 'active')
      .maybeSingle();

    if (!connectionRow) {
      throw new Error(`A2A connection ${connectionId} not found or inactive`);
    }

    const promptTemplate = (config.prompt as string) || '';
    const prompt = resolveContextTemplate(promptTemplate, context);

    const message: A2AMessage = {
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
    };

    const { sendTask, parseConnectionRow } = await import('../../a2a/client.js');
    const connection = parseConnectionRow(connectionRow as Record<string, unknown>);
    const { task: a2aTask } = await sendTask(connection as DbA2AConnection, message, deps.db);

    const resultText = a2aTask.status.message?.parts
      ?.filter((p: { type: string }): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p: { type: string; text: string }) => p.text)
      .join('\n') || `A2A task completed with status: ${a2aTask.status.state}`;

    logger.info(`[ActionExecutor] a2a_call completed: ${a2aTask.status.state}`);
    return { text: resultText, a2a_task_id: a2aTask.id, status: a2aTask.status.state };
  },
};
