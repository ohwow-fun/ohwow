/**
 * llm Tool Executor — agent-execution path.
 *
 * Handles the `llm` tool when an agent task calls it during a cognitive
 * cycle. Delegates to runLlmCall (execution/llm-organ.ts) so the routing
 * logic is shared with the orchestrator-side tool.
 */

import { runLlmCall } from '../llm-organ.js';
import type { ToolCallResult, ToolExecutionContext, ToolExecutor } from './types.js';

export const llmExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return toolName === 'llm';
  },

  async execute(
    _toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!ctx.modelRouter) {
      return {
        content: 'llm tool: ModelRouter is not available in this task context.',
        is_error: true,
      };
    }

    const result = await runLlmCall(
      {
        modelRouter: ctx.modelRouter,
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        currentAgentId: ctx.agentId,
        currentTaskId: ctx.taskId,
      },
      input,
    );

    if (!result.ok) {
      return { content: result.error, is_error: true };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.data, null, 2),
        },
      ],
    };
  },
};
