/**
 * Draft tool executor: save deferred actions for user approval.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import { isDraftTool, buildDeferredAction } from '../draft-tools.js';

export const draftExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return isDraftTool(toolName);
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const deferredAction = buildDeferredAction(toolName, input);
    await ctx.db.from('agent_workforce_tasks').update({
      deferred_action: JSON.stringify(deferredAction),
    }).eq('id', ctx.taskId);

    return {
      content: 'Draft saved. It will be executed after user approval.',
    };
  },
};
