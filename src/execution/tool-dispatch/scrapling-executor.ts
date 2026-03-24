/**
 * Scrapling tool executor: web scraping tools.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import { isScraplingTool, executeScraplingTool } from '../scrapling/index.js';

export const scraplingExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return isScraplingTool(toolName);
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    try {
      const result = await executeScraplingTool(ctx.scraplingService, toolName, input);
      return {
        content: result.success
          ? result.content || JSON.stringify(result.data)
          : `Error: ${result.error}`,
        is_error: !result.success,
      };
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : 'Scrapling tool failed'}`,
        is_error: true,
      };
    }
  },
};
