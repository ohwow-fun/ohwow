/**
 * request_desktop executor: activate desktop control on-demand.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import {
  LocalDesktopService,
  DESKTOP_ACTIVATION_MESSAGE,
  DESKTOP_SYSTEM_PROMPT,
} from '../desktop/index.js';

export const requestDesktopExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return toolName === 'request_desktop';
  },

  async execute(
    _toolName: string,
    _input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!ctx.desktopActivated) {
      ctx.desktopService = new LocalDesktopService({ dataDir: ctx.dataDir });
      ctx.desktopActivated = true;
    }

    return {
      content: `${DESKTOP_ACTIVATION_MESSAGE}\n\n${DESKTOP_SYSTEM_PROMPT}`,
      desktopActivated: true,
    };
  },
};
