/**
 * Browser tool executor: handle all browser tools (navigate, click, etc.).
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import {
  isBrowserTool,
  executeBrowserTool,
  formatBrowserToolResult,
  saveScreenshotLocally,
} from '../browser/index.js';

export const browserExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return isBrowserTool(toolName);
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!ctx.browserService) {
      return { content: 'Error: Browser not activated. Call request_browser first.', is_error: true };
    }

    const result = await executeBrowserTool(ctx.browserService, toolName, input);
    const formatted = formatBrowserToolResult(result);

    if (result.screenshot && ctx.dataDir) {
      try {
        const saved = await saveScreenshotLocally(result.screenshot, ctx.dataDir);
        formatted.push({ type: 'text', text: `Screenshot saved to ${saved.path}` });
      } catch { /* non-fatal */ }
    }

    return { content: formatted };
  },
};
