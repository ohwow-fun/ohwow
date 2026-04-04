/**
 * Deep Research Orchestrator Tool
 * Wraps the research skill for use in the orchestrator chat.
 */

import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import { executeResearch, type ResearchDepth, type LocalKnowledgeOptions } from '../../execution/skills/research.js';

export async function deepResearch(
  ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const question = input.question as string;
  if (!question) return { success: false, error: 'question is required' };

  const depth = (input.depth as ResearchDepth) || 'thorough';
  const validDepths: ResearchDepth[] = ['quick', 'thorough', 'comprehensive'];
  if (!validDepths.includes(depth)) {
    return { success: false, error: `depth must be one of: ${validDepths.join(', ')}` };
  }

  try {
    // We need the Anthropic API key — get it from the engine config
    // For now, access it through a workaround: the context doesn't expose it directly,
    // but we can use the control plane or a config reference
    // The simplest approach: the tool context should have the API key
    // Since it doesn't, we'll need to pass it through. For now, we'll return an error
    // if the engine doesn't support it.

    // Access the API key through the engine's internal state
    // This is a pragmatic solution — the engine has the key already
    const engineConfig = (ctx.engine as unknown as { config?: { anthropicApiKey: string } }).config;
    const apiKey = engineConfig?.anthropicApiKey;

    if (!apiKey) {
      return { success: false, error: 'Anthropic API key not available for research' };
    }

    const localKnowledge: LocalKnowledgeOptions | undefined = ctx.db ? {
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      ollamaUrl: ctx.ollamaUrl,
      embeddingModel: ctx.embeddingModel,
      ollamaModel: ctx.ollamaModel,
      ragBm25Weight: ctx.ragBm25Weight,
      rerankerEnabled: ctx.rerankerEnabled,
    } : undefined;

    const result = await executeResearch(question, depth, apiKey, ctx.modelRouter, localKnowledge);

    return {
      success: true,
      data: {
        report: result.report,
        queryCount: result.queryCount,
        sourceCount: result.sourceCount,
        localSourceCount: result.localSourceCount,
        tokensUsed: result.tokensUsed,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Research failed';
    return { success: false, error: msg };
  }
}
