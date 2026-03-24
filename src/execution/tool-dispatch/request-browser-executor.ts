/**
 * request_browser executor: activate the browser on-demand.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import {
  LocalBrowserService,
  BROWSER_ACTIVATION_MESSAGE,
  BROWSER_SYSTEM_PROMPT,
} from '../browser/index.js';

export const requestBrowserExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return toolName === 'request_browser';
  },

  async execute(
    _toolName: string,
    _input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!ctx.browserActivated) {
      ctx.browserService = new LocalBrowserService({ headless: ctx.browserHeadless });
      ctx.browserActivated = true;
    }

    return {
      content: `${BROWSER_ACTIVATION_MESSAGE}\n\n${BROWSER_SYSTEM_PROMPT}`,
      browserActivated: true,
    };
  },
};
