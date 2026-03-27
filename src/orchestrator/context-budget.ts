/**
 * Context Budget Manager
 * Tracks token usage against model capacity for Ollama conversations.
 * Uses the same estimation heuristic as the rest of the codebase: Math.ceil(text.length / 4).
 */

/** Estimate token count for a string (consistent with codebase convention) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for a message (handles string and array content) */
export function estimateMessageTokens(message: { role: string; content: string | unknown[] }): number {
  if (typeof message.content === 'string') {
    return estimateTokens(message.content) + 4; // +4 for role/formatting overhead
  }
  return estimateTokens(JSON.stringify(message.content)) + 4;
}

export interface ContextBudgetState {
  modelCapacity: number;
  systemPromptTokens: number;
  toolTokens: number;
  historyTokens: number;
  reservedForResponse: number;
  availableTokens: number;
  utilizationPct: number;
  messageCount: number;
}

export class ContextBudget {
  private modelCapacity: number;
  private reservedForResponse: number;
  private systemPromptTokens: number = 0;
  private toolTokens: number = 0;
  private historyTokens: number = 0;
  private messageCount: number = 0;

  constructor(modelCapacity: number, reservedForResponse: number = 4096) {
    this.modelCapacity = modelCapacity;
    this.reservedForResponse = reservedForResponse;
  }

  /** Set token count for system prompt */
  setSystemPrompt(prompt: string): void {
    this.systemPromptTokens = estimateTokens(prompt);
  }

  /** Set token count for tool definitions (OpenAI format tools sent alongside messages) */
  setToolTokens(count: number): void {
    this.toolTokens = count;
  }

  /** Get remaining tokens available for conversation history */
  get availableForHistory(): number {
    return Math.max(0, this.modelCapacity - this.systemPromptTokens - this.toolTokens - this.reservedForResponse);
  }

  /** Get current state snapshot */
  getState(): ContextBudgetState {
    const used = this.systemPromptTokens + this.toolTokens + this.historyTokens + this.reservedForResponse;
    return {
      modelCapacity: this.modelCapacity,
      systemPromptTokens: this.systemPromptTokens,
      toolTokens: this.toolTokens,
      historyTokens: this.historyTokens,
      reservedForResponse: this.reservedForResponse,
      availableTokens: Math.max(0, this.modelCapacity - used),
      utilizationPct: Math.round((used / this.modelCapacity) * 100),
      messageCount: this.messageCount,
    };
  }

  /**
   * Trim messages array to fit within the context budget.
   * Removes oldest messages first, always keeping at least the last message (current user input).
   * Returns the trimmed array and updates internal token tracking.
   */
  trimToFit<T extends { role: string; content: string | unknown[] }>(messages: T[]): T[] {
    if (messages.length === 0) return messages;

    const budget = this.availableForHistory;
    const tokenCounts = messages.map(m => estimateMessageTokens(m));
    let totalTokens = tokenCounts.reduce((sum, t) => sum + t, 0);

    // If everything fits, return as-is
    if (totalTokens <= budget) {
      this.historyTokens = totalTokens;
      this.messageCount = messages.length;
      return messages;
    }

    // Remove oldest messages until we fit (always keep at least the last message)
    let startIdx = 0;
    while (totalTokens > budget && startIdx < messages.length - 1) {
      totalTokens -= tokenCounts[startIdx];
      startIdx++;
    }

    const trimmed = messages.slice(startIdx);
    this.historyTokens = totalTokens;
    this.messageCount = trimmed.length;
    return trimmed;
  }

  /**
   * Summarize-and-trim: instead of dropping old messages entirely, condense them
   * into a single context summary message. Preserves the first user message (original intent)
   * and the last `keepRecent` messages (recent context).
   *
   * This is a fast, local-only approach (no LLM call). For LLM-based distillation,
   * use the mid-loop summarization in engine.ts.
   */
  /**
   * Check if the context budget is tight (less than `threshold` tokens available for history).
   * Useful for deciding whether to compress tools or switch to compact prompts.
   */
  isTight(threshold: number = 2000): boolean {
    return this.availableForHistory < threshold;
  }

  summarizeAndTrim<T extends { role: string; content: string | unknown[] }>(
    messages: T[],
    keepRecent: number = 4,
  ): T[] {
    if (messages.length === 0) return messages;

    const budget = this.availableForHistory;
    const tokenCounts = messages.map(m => estimateMessageTokens(m));
    const totalTokens = tokenCounts.reduce((sum, t) => sum + t, 0);

    // If everything fits, return as-is
    if (totalTokens <= budget) {
      this.historyTokens = totalTokens;
      this.messageCount = messages.length;
      return messages;
    }

    // Always keep: first message (original intent) + last N messages (recent context)
    const safeKeepRecent = Math.min(keepRecent, messages.length - 1);
    if (messages.length <= safeKeepRecent + 1) {
      // Not enough messages to summarize — fall back to trimToFit
      return this.trimToFit(messages);
    }

    const firstMessage = messages[0];
    const middleMessages = messages.slice(1, messages.length - safeKeepRecent);
    const recentMessages = messages.slice(messages.length - safeKeepRecent);

    // Build a concise summary from the middle messages (no LLM, just key extraction)
    const summaryParts: string[] = [];
    for (const msg of middleMessages) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);

      if (msg.role === 'assistant') {
        // Extract first 150 chars of assistant reasoning
        const snippet = content.slice(0, 150).replace(/\n/g, ' ');
        if (snippet.trim()) summaryParts.push(`Assistant: ${snippet}...`);
      } else if (msg.role === 'user' || msg.role === 'tool') {
        // For tool results, just note the tool was called
        if (content.includes('tool_result') || msg.role === 'tool') {
          summaryParts.push('(tool results processed)');
        } else {
          const snippet = content.slice(0, 100).replace(/\n/g, ' ');
          if (snippet.trim()) summaryParts.push(`User: ${snippet}...`);
        }
      }
    }

    // Deduplicate consecutive "(tool results processed)" entries
    const deduped = summaryParts.filter(
      (part, i) => !(part === '(tool results processed)' && summaryParts[i - 1] === '(tool results processed)'),
    );

    const summaryText = `[Previous context summary (${middleMessages.length} messages condensed):\n${deduped.join('\n')}\n]`;

    // Create the summary message with the same role as a user message
    const summaryMessage: T = { role: 'user', content: summaryText } as T;

    const result = [firstMessage, summaryMessage, ...recentMessages];

    // Verify it fits; if not, fall back to trimToFit
    const resultTokens = result.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    if (resultTokens > budget) {
      return this.trimToFit(result);
    }

    this.historyTokens = resultTokens;
    this.messageCount = result.length;
    return result;
  }
}

/** Estimate token count for an array of OpenAI-format tool definitions. */
export function estimateToolTokens(tools: { type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }[]): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateTokens(tool.function.name);
    total += estimateTokens(tool.function.description);
    total += estimateTokens(JSON.stringify(tool.function.parameters));
    total += 10; // per-tool framing overhead
  }
  return total;
}
