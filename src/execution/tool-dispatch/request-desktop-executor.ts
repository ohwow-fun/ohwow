/**
 * request_desktop executor: activate desktop control on-demand.
 * Enforces a single-session lock so only one task can control the desktop at a time.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import {
  LocalDesktopService,
  DESKTOP_ACTIVATION_MESSAGE,
  DESKTOP_SYSTEM_PROMPT,
  desktopLock,
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
      // Enforce single-session mutex
      const acquired = desktopLock.acquire(ctx.agentId, ctx.taskId);
      if (!acquired) {
        const holder = desktopLock.getHolder();
        return {
          content: `Desktop is currently being used by another task (agent: ${holder?.agentId}, task: ${holder?.taskId}). Wait for it to finish or ask the user to stop it first.`,
          is_error: true,
        };
      }

      ctx.desktopService = new LocalDesktopService({
        dataDir: ctx.dataDir,
        ...ctx.desktopOptions,
      });
      ctx.desktopActivated = true;
    }

    return {
      content: `${DESKTOP_ACTIVATION_MESSAGE}\n\n${DESKTOP_SYSTEM_PROMPT}`,
      desktopActivated: true,
    };
  },
};
