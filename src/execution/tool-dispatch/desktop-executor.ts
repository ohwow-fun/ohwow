/**
 * Desktop tool executor: handle all desktop tools (screenshot, click, etc.).
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import {
  isDesktopTool,
  executeDesktopTool,
  formatDesktopToolResult,
} from '../desktop/index.js';
import { saveScreenshotLocally } from '../browser/index.js';
import { LocalActionJournalService } from '../../lib/action-journal.js';

export const desktopExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return isDesktopTool(toolName);
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!ctx.desktopService) {
      return { content: 'Error: Desktop not activated. Call request_desktop first.', is_error: true };
    }

    const result = await executeDesktopTool(ctx.desktopService, toolName, input);
    const formatted = formatDesktopToolResult(result);

    if (result.screenshot && ctx.dataDir) {
      try {
        const saved = await saveScreenshotLocally(result.screenshot, ctx.dataDir);
        formatted.push({ type: 'text', text: `Screenshot saved to ${saved.path}` });
      } catch { /* non-fatal */ }
    }

    // Log to action journal for audit trail
    try {
      const journal = new LocalActionJournalService(ctx.db, ctx.workspaceId);
      await journal.logAction({
        taskId: ctx.taskId,
        agentId: ctx.agentId,
        toolName,
        toolInput: { ...input, frontmostApp: result.frontmostApp },
        toolOutput: { success: result.success, type: result.type, error: result.error },
        reversibility: 'irreversible',
      });
    } catch { /* non-fatal: don't break desktop control if audit fails */ }

    return { content: formatted };
  },
};
