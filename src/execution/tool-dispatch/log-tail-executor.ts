/**
 * log_tail dispatch adapter.
 * Wires the typed observability tool into the engine's tool registry.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import { isLogTailTool, executeLogTail } from '../observability/index.js';

export const logTailExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return isLogTailTool(toolName);
  },

  async execute(
    _toolName: string,
    input: Record<string, unknown>,
    _ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    try {
      const result = await executeLogTail(input);
      return { content: result.content, is_error: result.is_error };
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : 'log_tail failed'}`,
        is_error: true,
      };
    }
  },
};
