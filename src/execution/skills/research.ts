/**
 * Deep Research Skill
 * Higher-order skill that plans multiple searches, synthesizes findings,
 * and produces a structured report with citations.
 *
 * Flow:
 * 1. AI generates search queries from the research question
 * 2. Executes searches in parallel (via web_search tool)
 * 3. Synthesizes findings into a structured report
 *
 * Exposed as `deep_research` tool in orchestrator.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  TextBlock,
  WebSearchTool20250305,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';
import { retrieveKnowledgeChunks, type RagChunk } from '../../lib/rag/retrieval.js';
import type { ModelRouter } from '../model-router.js';

const WEB_SEARCH_TOOL: WebSearchTool20250305 = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 10,
};

const QUERY_GENERATION_PROMPT = `You are a research planning assistant. Given a research question, generate 3-5 specific web search queries that would help answer it comprehensively.

Respond with ONLY a JSON array of search query strings:
["query 1", "query 2", "query 3"]

Rules:
- Each query should target a different angle or subtopic
- Use specific, focused search terms
- Include queries for statistics, expert opinions, and recent developments`;

const SYNTHESIS_PROMPT = `You are a research synthesis assistant. Given raw search results, produce a clear, structured report.

Format your report with:
- A brief executive summary (2-3 sentences)
- Key findings organized by theme
- Citations referencing the sources

Some information may come from the user's local knowledge base (marked as "Local Knowledge"). Prioritize local knowledge when it's relevant, as it represents the user's own documents and context.

Keep the report concise and actionable. Use bullet points for findings.`;

export type ResearchDepth = 'quick' | 'thorough' | 'comprehensive';

export interface LocalKnowledgeOptions {
  db: DatabaseAdapter;
  workspaceId: string;
  ollamaUrl?: string;
  embeddingModel?: string;
  ollamaModel?: string;
  ragBm25Weight?: number;
  rerankerEnabled?: boolean;
}

export interface ResearchResult {
  report: string;
  queryCount: number;
  sourceCount: number;
  localSourceCount: number;
  tokensUsed: number;
}

/**
 * Execute a deep research task.
 * Uses Anthropic's web search tool to gather information,
 * then synthesizes findings into a structured report.
 */
export async function executeResearch(
  question: string,
  depth: ResearchDepth,
  anthropicApiKey: string,
  modelRouter?: ModelRouter | null,
  localKnowledge?: LocalKnowledgeOptions,
): Promise<ResearchResult> {
  const client = new Anthropic({ apiKey: anthropicApiKey });
  let totalTokens = 0;
  let localSourceCount = 0;

  // Step 1: Generate search queries
  const queryCount = depth === 'quick' ? 2 : depth === 'thorough' ? 4 : 6;

  let queries: string[];
  if (modelRouter) {
    const provider = await modelRouter.getProvider('orchestrator');
    const response = await provider.createMessage({
      system: QUERY_GENERATION_PROMPT,
      messages: [{ role: 'user', content: `Research question: ${question}\nGenerate ${queryCount} search queries.` }],
      maxTokens: 512,
      temperature: 0.3,
    });
    totalTokens += response.inputTokens + response.outputTokens;
    try {
      queries = JSON.parse(response.content);
      if (!Array.isArray(queries)) queries = [question];
    } catch {
      queries = [question];
    }
  } else {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      temperature: 0.3,
      system: QUERY_GENERATION_PROMPT,
      messages: [{ role: 'user', content: `Research question: ${question}\nGenerate ${queryCount} search queries.` }],
    });
    totalTokens += response.usage.input_tokens + response.usage.output_tokens;
    const text = response.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    try {
      queries = JSON.parse(text);
      if (!Array.isArray(queries)) queries = [question];
    } catch {
      queries = [question];
    }
  }

  // Step 1.5: Retrieve local knowledge if available
  let localKnowledgeContext = '';
  if (localKnowledge) {
    try {
      const localChunks: RagChunk[] = await retrieveKnowledgeChunks({
        db: localKnowledge.db,
        workspaceId: localKnowledge.workspaceId,
        agentId: '__orchestrator__',
        query: question,
        tokenBudget: 4000,
        maxChunks: 5,
        ollamaUrl: localKnowledge.ollamaUrl,
        embeddingModel: localKnowledge.embeddingModel,
        ollamaModel: localKnowledge.ollamaModel,
        bm25Weight: localKnowledge.ragBm25Weight,
        rerankerEnabled: localKnowledge.rerankerEnabled,
      });

      if (localChunks.length > 0) {
        localSourceCount = localChunks.length;
        const formattedChunks = localChunks
          .map((c) => `[Document: ${c.documentTitle}]\n${c.content}`)
          .join('\n---\n');
        localKnowledgeContext = `\nThe user has the following relevant documents in their local knowledge base. Reference these when applicable:\n\n--- Local Knowledge ---\n${formattedChunks}\n---\n`;
        logger.info({ count: localChunks.length }, '[research] Retrieved local knowledge chunks');
      }
    } catch (err) {
      logger.warn({ err }, '[research] Failed to retrieve local knowledge, continuing with web search only');
    }
  }

  // Step 2: Execute searches using Claude with web search tool
  // We make a single call with all queries to let Claude search efficiently
  const searchPrompt = `Research the following question thoroughly by searching for information:

Question: ${question}
${localKnowledgeContext}
Search for these specific aspects:
${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Search for each aspect, then compile ALL the information you find. Include URLs and sources.`;

  const searchSystemPrompt = 'You are a thorough research assistant. Search for information and compile detailed findings with sources.'
    + (localKnowledgeContext ? ' The user has provided local knowledge documents. Incorporate relevant information from those documents alongside your web search findings.' : '');

  const searchResponse = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: searchSystemPrompt,
    messages: [{ role: 'user', content: searchPrompt }],
    tools: [WEB_SEARCH_TOOL],
  });

  totalTokens += searchResponse.usage.input_tokens + searchResponse.usage.output_tokens;

  const rawFindings = searchResponse.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  // Count sources (rough heuristic: count URLs)
  const sourceCount = (rawFindings.match(/https?:\/\//g) || []).length;

  // Step 3: Synthesize into a report
  let report: string;
  if (modelRouter) {
    const provider = await modelRouter.getProvider('orchestrator');
    const response = await provider.createMessage({
      system: SYNTHESIS_PROMPT,
      messages: [{ role: 'user', content: `Research question: ${question}\n\nRaw findings:\n${rawFindings}\n\nSynthesize these findings into a structured report.` }],
      maxTokens: 2048,
      temperature: 0.3,
    });
    totalTokens += response.inputTokens + response.outputTokens;
    report = response.content;
  } else {
    const synthResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      temperature: 0.3,
      system: SYNTHESIS_PROMPT,
      messages: [{ role: 'user', content: `Research question: ${question}\n\nRaw findings:\n${rawFindings}\n\nSynthesize these findings into a structured report.` }],
    });
    totalTokens += synthResponse.usage.input_tokens + synthResponse.usage.output_tokens;
    report = synthResponse.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }

  return {
    report,
    queryCount: queries.length,
    sourceCount,
    localSourceCount,
    tokensUsed: totalTokens,
  };
}
