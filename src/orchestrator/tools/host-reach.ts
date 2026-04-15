/**
 * Host-reach tool handlers for the orchestrator.
 *
 * Wraps the shared `executeHostReachTool` executor into the LocalToolContext
 * success/error shape. No workspace/guard state is needed — these tools
 * touch the host directly, not the filesystem sandbox.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { executeHostReachTool } from '../../execution/host/index.js';

function wrap(toolName: string) {
  return async (_ctx: LocalToolContext, input: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const result = await executeHostReachTool(toolName, input ?? {});
      if (result.is_error) {
        return { success: false, error: result.content };
      }
      return { success: true, data: result.content };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : `${toolName} failed`,
      };
    }
  };
}

export const notifyUserHandler = wrap('notify_user');
export const speakHandler = wrap('speak');
export const clipboardReadHandler = wrap('clipboard_read');
export const clipboardWriteHandler = wrap('clipboard_write');
export const openUrlHandler = wrap('open_url');
