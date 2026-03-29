/**
 * Filesystem tool executor: file read/write/list operations.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import { isFilesystemTool, executeFilesystemTool } from '../filesystem/index.js';

export const filesystemExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return isFilesystemTool(toolName);
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!ctx.fileAccessGuard) {
      return { content: 'Error: File access not enabled for this agent.', is_error: true };
    }

    try {
      const result = await executeFilesystemTool(ctx.fileAccessGuard, toolName, input);
      return {
        content: result.content,
        is_error: result.is_error,
      };
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : 'Filesystem tool failed'}`,
        is_error: true,
      };
    }
  },
};
