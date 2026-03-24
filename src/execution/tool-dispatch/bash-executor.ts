/**
 * Bash tool executor: shell command execution.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import { isBashTool, executeBashTool } from '../bash/index.js';

export const bashExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return isBashTool(toolName);
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!ctx.fileAccessGuard) {
      return { content: 'Error: Bash access not enabled for this agent.', is_error: true };
    }

    try {
      const result = await executeBashTool(ctx.fileAccessGuard, toolName, input);
      return {
        content: result.content,
        is_error: result.is_error,
      };
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : 'Bash tool failed'}`,
        is_error: true,
      };
    }
  },
};
