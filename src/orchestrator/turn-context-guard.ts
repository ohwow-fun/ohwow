/**
 * Turn Context Guard
 *
 * Two helpers that keep a single chat turn's tool-loop from blowing
 * past the model's context limit:
 *
 *   1. compactStaleToolResults — walks an in-flight loopMessages array
 *      and replaces tool_result blocks older than KEEP_RECENT_RESULTS
 *      iterations with a one-line placeholder. Most tool results stop
 *      being load-bearing as soon as the model produces text following
 *      them; keeping the verbatim 5kb directory listing or 800-line
 *      file dump in the prompt for the rest of the turn is pure waste.
 *
 *   2. checkTurnTokenBudget — projects input tokens against the
 *      working context limit and tells the caller when to break out of
 *      the loop gracefully instead of plowing into a 402 / context
 *      overflow. Returns a structured decision so the caller can yield
 *      a "made progress, ask me to continue" message and persist
 *      partial state.
 *
 * Both helpers are loop-engine-agnostic: they accept a generic message
 * shape and return either a transformed array or a verdict struct.
 * That lets the same code apply to the Anthropic, OpenRouter, and
 * Ollama paths in local-orchestrator without three copies.
 */

import { logger } from '../lib/logger.js';
import { estimateTokens } from './context-budget.js';

// ----------------------------------------------------------------------
// Compaction
// ----------------------------------------------------------------------

/**
 * Number of most-recent tool-result blocks to preserve verbatim. The
 * model is still actively reasoning about these, so compacting them
 * would lose information. Older results stay as one-line placeholders.
 */
const KEEP_RECENT_RESULTS = 4;

/**
 * Tool results below this token budget are kept as-is even when stale.
 * No point compacting a 30-token "ok" response — the placeholder costs
 * about that much itself.
 */
const COMPACT_MIN_TOKENS = 80;

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

interface AnthropicMessageLike {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
}

interface OpenAIToolMessage {
  role: 'tool';
  content: string | unknown;
  tool_call_id?: string;
  name?: string;
}

interface CompactionResult<T> {
  messages: T[];
  compactedCount: number;
  tokensSaved: number;
}

/**
 * Anthropic-shaped compaction. Tool results live inside user-role
 * messages as content blocks of type 'tool_result'. We walk the array
 * in reverse, keep the first KEEP_RECENT_RESULTS results untouched,
 * and replace older ones with a `[tool_result: <N tokens, summary>]`
 * placeholder text block.
 */
export function compactStaleToolResults<T extends AnthropicMessageLike>(
  messages: T[],
): CompactionResult<T> {
  let resultsSeen = 0;
  let compactedCount = 0;
  let tokensSaved = 0;

  // Walk newest → oldest so the freshest results are protected.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;

    let modifiedContent: unknown[] | null = null;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j] as { type?: string };
      if (block?.type !== 'tool_result') continue;

      resultsSeen++;
      if (resultsSeen <= KEEP_RECENT_RESULTS) continue;

      const tr = block as unknown as AnthropicToolResultBlock;
      if (isAlreadyCompacted(tr)) continue;

      const before = estimateToolResultTokens(tr);
      if (before < COMPACT_MIN_TOKENS) continue;

      const placeholder = makeCompactedToolResult(tr, before);
      const after = estimateToolResultTokens(placeholder);
      if (modifiedContent === null) modifiedContent = [...msg.content];
      modifiedContent[j] = placeholder;
      compactedCount++;
      tokensSaved += Math.max(0, before - after);
    }

    if (modifiedContent) {
      messages[i] = { ...msg, content: modifiedContent } as T;
    }
  }

  if (compactedCount > 0) {
    logger.debug(
      { compactedCount, tokensSaved },
      '[turn-context-guard] compacted stale tool results',
    );
  }

  return { messages, compactedCount, tokensSaved };
}

/**
 * OpenAI / OpenRouter / Ollama use top-level `role: 'tool'` messages
 * instead of nested content blocks. Same idea: keep the most recent N
 * verbatim, replace older ones with a one-line placeholder string.
 */
export function compactStaleOpenAIToolResults<T extends OpenAIToolMessage | { role: string; content: unknown }>(
  messages: T[],
): CompactionResult<T> {
  let resultsSeen = 0;
  let compactedCount = 0;
  let tokensSaved = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;

    resultsSeen++;
    if (resultsSeen <= KEEP_RECENT_RESULTS) continue;

    const contentStr = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);

    if (contentStr.startsWith('[compacted:')) continue;

    const before = estimateTokens(contentStr);
    if (before < COMPACT_MIN_TOKENS) continue;

    const summary = summarizeToolResultText(contentStr);
    const placeholder = `[compacted: ${summary}]`;
    const after = estimateTokens(placeholder);

    messages[i] = { ...msg, content: placeholder } as T;
    compactedCount++;
    tokensSaved += Math.max(0, before - after);
  }

  if (compactedCount > 0) {
    logger.debug(
      { compactedCount, tokensSaved },
      '[turn-context-guard] compacted stale OpenAI tool results',
    );
  }

  return { messages, compactedCount, tokensSaved };
}

function isAlreadyCompacted(tr: AnthropicToolResultBlock): boolean {
  if (typeof tr.content === 'string') return tr.content.startsWith('[compacted:');
  if (Array.isArray(tr.content) && tr.content.length === 1) {
    const first = tr.content[0];
    return typeof first?.text === 'string' && first.text.startsWith('[compacted:');
  }
  return false;
}

function estimateToolResultTokens(tr: AnthropicToolResultBlock): number {
  if (typeof tr.content === 'string') return estimateTokens(tr.content);
  if (Array.isArray(tr.content)) {
    let sum = 0;
    for (const block of tr.content) {
      if (typeof block?.text === 'string') sum += estimateTokens(block.text);
    }
    return sum;
  }
  return 0;
}

function makeCompactedToolResult(
  tr: AnthropicToolResultBlock,
  originalTokens: number,
): AnthropicToolResultBlock {
  const text = typeof tr.content === 'string'
    ? tr.content
    : Array.isArray(tr.content)
      ? tr.content.map((b) => b?.text ?? '').join('\n')
      : '';
  const summary = summarizeToolResultText(text);
  return {
    type: 'tool_result',
    tool_use_id: tr.tool_use_id,
    content: `[compacted: ${originalTokens}t — ${summary}]`,
    is_error: tr.is_error,
  };
}

/**
 * One-line summary of a tool result for the placeholder. Keeps a small
 * factual fragment so the model can still reason about "what did that
 * call return" at a coarse level — it just doesn't waste 5kb on the
 * full body. Truncates to 120 chars and strips newlines.
 */
function summarizeToolResultText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 120) return collapsed;
  return `${collapsed.slice(0, 117)}...`;
}

// ----------------------------------------------------------------------
// Per-result clamp
// ----------------------------------------------------------------------

/**
 * Default ceiling for a single tool result before compaction runs. 8000
 * characters is ~2000 tokens under the `chars/4` heuristic — enough room
 * for a useful dump (a short file, a small directory listing, a focused
 * grep) but small enough that a pathological 500KB response can't pin the
 * context budget through four iterations of verbatim retention.
 */
export const DEFAULT_TOOL_RESULT_CHAR_CAP = 8000;

/**
 * Clamp a single tool-result string so one runaway output (a grep over
 * the whole repo, a 10k-line directory listing, a full-file dump) can't
 * dominate the loopMessages budget for the four iterations before
 * compactStaleToolResults kicks in. Keeps the head of the output verbatim
 * so the model can still read the first findings, replaces the tail with
 * an explicit `[truncated: kept N of M chars…]` marker the model can
 * recognize and use as a cue to call the tool again with a narrower
 * query.
 *
 * Bug #9 guard — caught during the S3.12 bench when a registry-wide grep
 * result accumulated across iterations faster than compaction could
 * catch up. Meant to be called at the tool-push site in each chat loop
 * (openrouter, ollama, anthropic), BEFORE the result enters loopMessages.
 */
export function clampToolResult(
  content: string,
  maxChars: number = DEFAULT_TOOL_RESULT_CHAR_CAP,
): string {
  if (content.length <= maxChars) return content;
  const head = content.slice(0, maxChars);
  const omitted = content.length - maxChars;
  return `${head}\n\n[truncated: kept ${maxChars} of ${content.length} chars — ${omitted} chars omitted. Call the tool again with a narrower query if you need the rest.]`;
}

// ----------------------------------------------------------------------
// Token budget guard
// ----------------------------------------------------------------------

export interface BudgetCheckInput {
  /** Hard model context window in tokens. */
  contextLimit: number;
  /** Tokens reserved for the assistant's reply. Default: 4096. */
  reserveForOutput?: number;
  /** Estimated tokens currently consumed by system prompt + tools. */
  staticTokens: number;
  /** Estimated tokens consumed by the in-flight loopMessages array. */
  messageTokens: number;
  /** How many iterations into the tool loop we are. */
  iteration: number;
  /** Total iterations allowed for this turn. */
  maxIterations: number;
}

export interface BudgetCheckVerdict {
  /** True when the loop should break out gracefully on this iteration. */
  shouldBreak: boolean;
  /** Soft warning: utilization above warn threshold but below hard. */
  shouldWarn: boolean;
  /** Current utilization (0–1+). */
  utilization: number;
  /** Human-readable reason for breaking. Used in the user-visible message. */
  reason: string;
}

/**
 * Conservative thresholds: warn at 60%, break at 75%. The remaining
 * 25% covers the model's actual output, the next user message, and a
 * safety margin for the inevitable underestimate from token estimation
 * heuristics. Better to break early and offer continuation than to hit
 * a 402 mid-stream.
 */
const WARN_THRESHOLD = 0.6;
const BREAK_THRESHOLD = 0.75;

export function checkTurnTokenBudget(input: BudgetCheckInput): BudgetCheckVerdict {
  const reserve = input.reserveForOutput ?? 4096;
  const usable = Math.max(1, input.contextLimit - reserve);
  const used = input.staticTokens + input.messageTokens;
  const utilization = used / usable;

  if (utilization >= BREAK_THRESHOLD) {
    return {
      shouldBreak: true,
      shouldWarn: true,
      utilization,
      reason: `context at ${Math.round(utilization * 100)}% (${used}t / ${usable}t usable) — breaking to save state`,
    };
  }
  if (utilization >= WARN_THRESHOLD) {
    return {
      shouldBreak: false,
      shouldWarn: true,
      utilization,
      reason: `context at ${Math.round(utilization * 100)}%`,
    };
  }
  return { shouldBreak: false, shouldWarn: false, utilization, reason: '' };
}

/**
 * Cheap estimator for an in-flight messages array. Walks the array
 * once and sums estimateTokens() over content. Doesn't need to be
 * exact — the budget guard adds a 25% safety margin on top.
 */
export function estimateMessagesTokens(messages: Array<{ content: unknown }>): number {
  let sum = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      sum += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ text?: string; content?: unknown }>) {
        if (typeof block?.text === 'string') {
          sum += estimateTokens(block.text);
        } else if (typeof block?.content === 'string') {
          sum += estimateTokens(block.content);
        } else if (block?.content) {
          sum += estimateTokens(JSON.stringify(block.content));
        }
      }
    } else if (msg.content) {
      sum += estimateTokens(JSON.stringify(msg.content));
    }
    sum += 4; // role / formatting overhead per message
  }
  return sum;
}

/**
 * Build the user-facing message yielded when the budget guard breaks
 * the loop. Keeps it short, names what was accomplished, and tells
 * them how to continue. The orchestrator calls this and yields the
 * text so the user gets a clean wrap-up instead of a 402 stack trace.
 */
export function buildBudgetExitMessage(opts: {
  iteration: number;
  toolsExecuted: number;
  reason: string;
}): string {
  const tools = opts.toolsExecuted === 1 ? '1 tool call' : `${opts.toolsExecuted} tool calls`;
  return (
    `\n\n*Pausing after ${tools} — ${opts.reason}. Send another message to continue from here.*`
  );
}
