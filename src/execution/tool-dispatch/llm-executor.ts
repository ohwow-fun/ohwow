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

    // Gap 13: wire the per-workspace autonomous daily cap. Agent-task
    // invocations default to origin='autonomous' so the meter sums them
    // toward the cap. When the daemon passes a populated `budgetDeps`,
    // the middleware will demote or halt the call and the pulse events
    // will fan out through the EventBus notifier attached in
    // `daemon/orchestration.ts`. When `budgetDeps` is null (unit test
    // contexts), the middleware is skipped so legacy tests stay green.
    const result = await runLlmCall(
      {
        modelRouter: ctx.modelRouter,
        db: ctx.db,
        workspaceId: ctx.workspaceId,
        currentAgentId: ctx.agentId,
        currentTaskId: ctx.taskId,
        budget: ctx.budgetDeps
          ? {
              meter: ctx.budgetDeps.meter,
              emittedToday: ctx.budgetDeps.emittedToday,
              emitPulse: ctx.budgetDeps.emitPulse,
              limitUsd: ctx.budgetLimitUsd,
              origin: 'autonomous',
            }
          : undefined,
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
