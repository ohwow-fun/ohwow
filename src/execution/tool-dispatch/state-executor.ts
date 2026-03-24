/**
 * State tool executor: persistent cross-task state read/write.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import { isStateTool, executeStateTool } from '../state/index.js';

export const stateExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return isStateTool(toolName);
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!ctx.agentId || !ctx.workspaceId) {
      return { content: 'Error: State tools require agent context.', is_error: true };
    }

    try {
      const result = await executeStateTool(toolName, input, {
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        defaultGoalId: ctx.goalId,
        taskId: ctx.taskId,
      });
      return {
        content: result.content,
        is_error: result.is_error,
      };
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : 'State tool failed'}`,
        is_error: true,
      };
    }
  },
};
