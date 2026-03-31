/**
 * MCP tool executor: Model Context Protocol tool dispatch with circuit breaker.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import { isMcpTool } from '../../mcp/index.js';

export const mcpExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return isMcpTool(toolName);
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!ctx.mcpClients?.hasTool(toolName)) {
      return { content: `Error: MCP tool "${toolName}" not available.`, is_error: true };
    }

    if (ctx.circuitBreaker.isDisabled(toolName)) {
      return {
        content: `Tool "${toolName}" temporarily disabled due to repeated failures.`,
        is_error: true,
      };
    }

    try {
      const result = await ctx.mcpClients.callTool(toolName, input);
      ctx.circuitBreaker.recordSuccess(toolName);
      return {
        content: result.content,
        is_error: result.is_error,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'MCP tool failed';

      // Transport error: reconnect once
      if (/EPIPE|ECONNREFUSED|not connected|transport/i.test(msg)) {
        const reconnected = await ctx.mcpClients.reconnectServer(toolName).catch(() => false);
        if (reconnected) {
          try {
            const retryResult = await ctx.mcpClients.callTool(toolName, input);
            ctx.circuitBreaker.recordSuccess(toolName);
            return {
              content: retryResult.content,
              is_error: retryResult.is_error,
            };
          } catch { /* fall through */ }
        }
      }

      ctx.circuitBreaker.recordFailure(toolName);

      // Hint: suggest browser as fallback when MCP fails
      let errorContent = `Error: ${msg}`;
      if (ctx.browserService || ctx.browserActivated) {
        errorContent += '\n\nHint: This MCP tool failed. If the task can be done through a web interface, consider using browser_* tools instead.';
      }

      return {
        content: errorContent,
        is_error: true,
      };
    }
  },
};
