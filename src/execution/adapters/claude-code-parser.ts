/**
 * Claude Code Stream-JSON Parser
 * Parses the newline-delimited JSON output from `claude --output-format stream-json`.
 *
 * Each line is a JSON object representing an event in the conversation.
 * Key event types:
 *   - system (init): contains session_id
 *   - assistant: contains text content and/or tool_use blocks
 *   - result: final summary with cost, tokens, session_id
 */

import { logger } from '../../lib/logger.js';

// ---------- Event types from Claude Code stream-json ----------

export interface ClaudeCodeStreamEvent {
  type: 'system' | 'assistant' | 'user' | 'result';
  subtype?: string;
  session_id?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: ContentBlock[];
    usage?: { input_tokens: number; output_tokens: number };
    stop_reason?: string;
  };
  result?: {
    session_id: string;
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    num_turns: number;
    is_error?: boolean;
  };
  // Tool result events
  tool_use_id?: string;
  content?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

// ---------- Progress callback ----------

export interface ProgressInfo {
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  toolName?: string;
  text?: string;
}

// ---------- Final result ----------

export interface ParsedClaudeCodeResult {
  sessionId: string | null;
  content: string;
  totalCostUsd: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  model: string;
  toolsUsed: string[];
  errors: string[];
}

// ---------- Parser ----------

export class ClaudeCodeStreamParser {
  private sessionId: string | null = null;
  private contentParts: string[] = [];
  private totalCostUsd = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private numTurns = 0;
  private model = 'unknown';
  private toolsUsed: string[] = [];
  private errors: string[] = [];
  private lastAssistantText = '';

  /**
   * Parse a single line of stream-json output.
   * Returns the parsed event or null if the line is empty/unparseable.
   */
  parseLine(line: string): ClaudeCodeStreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed) as ClaudeCodeStreamEvent;
    } catch {
      // Some lines may be partial or non-JSON (e.g., stderr mixed in)
      if (trimmed.length > 0) {
        logger.debug(`[claude-code-parser] Unparseable line: ${trimmed.slice(0, 100)}`);
      }
      return null;
    }
  }

  /**
   * Process a parsed event, updating internal state and optionally calling onProgress.
   */
  processEvent(event: ClaudeCodeStreamEvent, onProgress?: (info: ProgressInfo) => void): void {
    // Capture session ID from system init or result
    if (event.session_id) {
      this.sessionId = event.session_id;
    }

    if (event.type === 'system') {
      // System init events may contain session_id at top level
      return;
    }

    if (event.type === 'assistant' && event.message) {
      const msg = event.message;

      // Track model
      if (msg.model) {
        this.model = msg.model;
      }

      // Accumulate tokens from each message
      if (msg.usage) {
        this.inputTokens += msg.usage.input_tokens;
        this.outputTokens += msg.usage.output_tokens;
      }

      // Process content blocks
      if (msg.content) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            this.lastAssistantText = block.text;
            onProgress?.({
              tokensUsed: this.inputTokens + this.outputTokens,
              inputTokens: this.inputTokens,
              outputTokens: this.outputTokens,
              text: block.text,
            });
          }

          if (block.type === 'tool_use' && block.name) {
            this.toolsUsed.push(block.name);
            onProgress?.({
              tokensUsed: this.inputTokens + this.outputTokens,
              inputTokens: this.inputTokens,
              outputTokens: this.outputTokens,
              toolName: block.name,
            });
          }
        }
      }
    }

    if (event.type === 'result' && event.result) {
      const result = event.result;
      this.sessionId = result.session_id || this.sessionId;
      this.totalCostUsd = result.total_cost_usd;
      this.numTurns = result.num_turns;

      // Use the result's token counts as authoritative (they cover the full session)
      if (result.total_input_tokens > 0) {
        this.inputTokens = result.total_input_tokens;
      }
      if (result.total_output_tokens > 0) {
        this.outputTokens = result.total_output_tokens;
      }

      if (result.is_error) {
        this.errors.push('Claude Code reported an error in the result');
      }
    }
  }

  /**
   * Process a raw line: parse + process in one step.
   */
  processLine(line: string, onProgress?: (info: ProgressInfo) => void): ClaudeCodeStreamEvent | null {
    const event = this.parseLine(line);
    if (event) {
      this.processEvent(event, onProgress);
    }
    return event;
  }

  /**
   * Get the final aggregated result after all events have been processed.
   * The content is the last assistant text block (Claude Code's final response).
   */
  getResult(): ParsedClaudeCodeResult {
    // Collect all text from the last assistant message as the final output
    const content = this.lastAssistantText;

    return {
      sessionId: this.sessionId,
      content,
      totalCostUsd: this.totalCostUsd,
      costCents: Math.ceil(this.totalCostUsd * 100),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      numTurns: this.numTurns,
      model: this.model,
      toolsUsed: [...new Set(this.toolsUsed)], // deduplicate
      errors: this.errors,
    };
  }
}
