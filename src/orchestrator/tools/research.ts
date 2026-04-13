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
    const engineConfig = (ctx.engine as unknown as { config?: { anthropicApiKey?: string } }).config;
    const apiKey = engineConfig?.anthropicApiKey || null;

    if (!apiKey && !ctx.modelRouter) {
      return { success: false, error: 'deep_research needs either an Anthropic API key or a model router' };
    }

    const localKnowledge: LocalKnowledgeOptions | undefined = ctx.db ? {
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      ollamaUrl: ctx.ollamaUrl,
      embeddingModel: ctx.embeddingModel,
      ollamaModel: ctx.ollamaModel,
      ragBm25Weight: ctx.ragBm25Weight,
      rerankerEnabled: ctx.rerankerEnabled,
      meshRagEnabled: ctx.meshRagEnabled,
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
