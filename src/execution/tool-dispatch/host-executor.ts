/**
 * Host-reach tool dispatch adapter.
 * Wires the typed macOS host tools (notify_user, speak, clipboard_read/write,
 * open_url) into the tool registry.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import { isHostReachTool, executeHostReachTool } from '../host/index.js';

export const hostReachExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return isHostReachTool(toolName);
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    _ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    try {
      const result = await executeHostReachTool(toolName, input);
      return { content: result.content, is_error: result.is_error };
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : 'Host tool failed'}`,
        is_error: true,
      };
    }
  },
};
