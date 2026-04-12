/**
 * llm Organ Tool (Orchestrator Wrapper)
 *
 * Thin adapter around runLlmCall from execution/llm-organ. The shared
 * helper owns the validation, routing, and call logic so both the
 * orchestrator-chat tool surface and the agent-execution tool executor
 * (execution/tool-dispatch/llm-executor) stay in lockstep.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { runLlmCall } from '../../execution/llm-organ.js';

export async function llmTool(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.modelRouter) {
    return {
      success: false,
      error: 'llm tool: ModelRouter is not available in this context. Start the daemon with a model provider configured.',
    };
  }

  const result = await runLlmCall(
    {
      modelRouter: ctx.modelRouter,
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      currentAgentId: ctx.currentAgentId,
    },
    input,
  );

  if (result.ok) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
