/**
 * Message Summarization — Token counting, context window, message truncation
 *
 * Extracted from RuntimeEngine. Summarizes older messages in a conversation
 * to reduce context usage. Uses a cheap model (Haiku) when available,
 * otherwise falls back to local text extraction.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TextBlock, MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ClaudeModel } from './ai-types.js';
import { CLAUDE_CONTEXT_LIMITS } from './ai-types.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Mid-loop context summarization constants.
 * When accumulated input tokens exceed this fraction of the model's context,
 * older messages are summarized to prevent context overflow.
 */
export const CONTEXT_SUMMARIZE_THRESHOLD_PCT = 0.6;
export const CONTEXT_WARNING_THRESHOLD_PCT = 0.7;
/** Skip summarization for this many iterations after a summarization occurs. */
export const SUMMARIZE_COOLDOWN_ITERATIONS = 2;
/** Resolve context limit for a given Anthropic model ID. */
export const MODEL_ID_TO_CLAUDE: Record<string, ClaudeModel> = {
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
  'claude-haiku-4-5-20251001': 'claude-haiku-4',
};
export const DEFAULT_CONTEXT_LIMIT = 200_000;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Resolve the context window limit for a given Anthropic model ID string.
 */
export function getContextLimit(modelId: string): number {
  const claudeModel = MODEL_ID_TO_CLAUDE[modelId];
  return claudeModel ? CLAUDE_CONTEXT_LIMITS[claudeModel] : DEFAULT_CONTEXT_LIMIT;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Summarize older messages in a conversation to reduce context usage.
 * Keeps the first message (original intent) and the last `keepRecent` messages.
 * Uses a cheap model (Haiku) when available, otherwise does local extraction.
 */
export async function summarizeMessages(
  messages: MessageParam[],
  anthropic: Anthropic | null,
  keepRecent: number = 3,
): Promise<MessageParam[]> {
  if (messages.length <= keepRecent + 1) return messages;

  const firstMessage = messages[0];
  const middleMessages = messages.slice(1, messages.length - keepRecent);
  const recentMessages = messages.slice(messages.length - keepRecent);

  // Try LLM-based summarization with Haiku
  if (anthropic) {
    try {
      const middleText = middleMessages.map(m => {
        const content = typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content);
        return `[${m.role}]: ${content.slice(0, 1000)}`;
      }).join('\n\n');

      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        temperature: 0,
        system: 'Summarize the key findings, decisions, and tool results from this conversation excerpt in under 500 tokens. Focus on facts and outcomes, not process.',
        messages: [{ role: 'user', content: middleText.slice(0, 8000) }],
      });

      const summaryText = response.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');

      if (summaryText) {
        logger.info(`[message-summarization] Mid-loop summarization: condensed ${middleMessages.length} messages`);
        const summaryMessage: MessageParam = {
          role: 'user',
          content: `[Context summary of ${middleMessages.length} previous messages:\n${summaryText}\n]`,
        };
        return [firstMessage, summaryMessage, ...recentMessages];
      }
    } catch (err) {
      logger.warn(`[message-summarization] LLM summarization failed, using local fallback: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Local fallback: extract key snippets
  const summaryParts: string[] = [];
  for (const msg of middleMessages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    if (msg.role === 'assistant') {
      const snippet = content.slice(0, 200).replace(/\n/g, ' ');
      if (snippet.trim()) summaryParts.push(`Assistant: ${snippet}...`);
    } else {
      const hasToolResult = content.includes('tool_result') || content.includes('tool_use');
      if (hasToolResult) {
        summaryParts.push('(tool interaction processed)');
      } else {
        const snippet = content.slice(0, 150).replace(/\n/g, ' ');
        if (snippet.trim()) summaryParts.push(`${msg.role}: ${snippet}...`);
      }
    }
  }
  // Deduplicate consecutive tool entries
  const deduped = summaryParts.filter(
    (part, i) => !(part === '(tool interaction processed)' && summaryParts[i - 1] === '(tool interaction processed)'),
  );
  const summaryMessage: MessageParam = {
    role: 'user',
    content: `[Context summary of ${middleMessages.length} previous messages:\n${deduped.join('\n')}\n]`,
  };
  logger.info(`[message-summarization] Mid-loop summarization (local): condensed ${middleMessages.length} messages`);
  return [firstMessage, summaryMessage, ...recentMessages];
}
