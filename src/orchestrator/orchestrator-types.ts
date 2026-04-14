/**
 * Orchestrator shared types, constants, and utilities.
 */

import type { ToolResult } from './local-tool-types.js';
import type { ChannelType } from '../integrations/channel-types.js';
export type { IntentSection } from './tool-definitions.js';

// ============================================================================
// EVENT TYPES
// ============================================================================

export type OrchestratorEvent =
  | { type: 'text'; content: string }
  | { type: 'status'; message: string }
  | { type: 'tool_start'; name: string; input: Record<string, unknown> }
  | { type: 'tool_done'; name: string; result: ToolResult }
  | { type: 'switch_tab'; tab: string }
  | { type: 'permission_request'; requestId: string; path: string; toolName: string }
  | { type: 'mcp_elicitation'; requestId: string; serverName: string; message: string; schema: Record<string, unknown> }
  | { type: 'plan_update'; tasks: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'done' }> }
  | { type: 'screenshot'; path: string; base64?: string }
  | { type: 'media_generated'; path: string }
  | { type: 'cost_confirmation'; requestId: string; toolName: string; estimatedCredits: number; description: string }
  | { type: 'sequence_start'; name: string; totalSteps: number; waves: number }
  | { type: 'sequence_step'; stepId: string; agentName: string; status: 'running' | 'done' | 'skipped' | 'abstained'; wave: number; reason?: string }
  | { type: 'sequence_done'; success: boolean; participatedCount: number; abstainedCount: number; totalCostCents: number }
  | { type: 'evolution_start'; runId: string; objective: string; agents: Array<{ id: string; name: string }>; maxRounds: number }
  | { type: 'evolution_round_start'; round: number }
  | { type: 'evolution_attempt_complete'; round: number; agentId: string; agentName: string; score: number; strategySummary: string; costCents: number }
  | { type: 'evolution_attempt_failed'; round: number; agentId: string; agentName: string; error: string }
  | { type: 'evolution_round_complete'; round: number; bestScore: number; bestAgentName: string }
  | { type: 'evolution_complete'; runId: string; bestScore: number | null; bestAgentName: string | null; bestDeliverable: string | null; totalRounds: number; totalAttempts: number; totalCostCents: number; stoppedReason: string }
  | { type: 'evolution_error'; error: string }
  | { type: 'done'; inputTokens: number; outputTokens: number; traceId?: string };

// ============================================================================
// INTENT TYPES
// ============================================================================

export type OrchestratorMode = 'explore' | 'execute' | 'conversational';

export interface ClassifiedIntent {
  intent: string;
  sections: Set<import('./tool-definitions.js').IntentSection>;
  statusLabel: string;
  /** Whether the request is complex enough to warrant a plan-first approach. */
  planFirst: boolean;
  /** Execution mode — controls tool subsetting and iteration limits. */
  mode: OrchestratorMode;
}

/** Per-mode iteration limits. High limits let the orchestrator be as thorough
 *  as Claude Code (50-100+ tool calls per complex task) instead of giving up early. */
export const MODE_MAX_ITERATIONS: Record<OrchestratorMode, number> = {
  explore: 25,
  execute: 50,
  conversational: 25,
};

// ============================================================================
// CHANNEL CHAT OPTIONS
// ============================================================================

export interface ChannelChatOptions {
  excludedTools: string[];
  transformToolInput?: (name: string, input: Record<string, unknown>) => Record<string, unknown>;
  platform?: ChannelType;
  /** Voice metadata passed from VoiceSession for auditory stimulus enrichment. */
  voiceContext?: {
    sttConfidence: number;
    sttProvider: string;
    language?: string;
    audioDurationMs: number;
  };
}

// ============================================================================
// CHAT TURN OPTIONS — per-call config snapshot (bug #6 fix)
// ============================================================================

/**
 * Per-turn configuration passed into LocalOrchestrator.chat(). Every field
 * here is a snapshot of state that the route handler USED to set on the
 * orchestrator instance via setOrchestratorModel / setModelSource /
 * setChatActor — but those setters race when 4 concurrent dispatches
 * land within the same event loop tick. ChatTurnOptions moves the config
 * onto the call stack so each chat carries its own snapshot.
 *
 * The instance setters stay in place for backward compatibility with
 * callers that haven't migrated yet (channel chat, voice, peer relay).
 * When `options` is omitted, runChat falls back to reading the instance
 * fields, preserving the legacy single-flight behavior.
 */
export interface ChatTurnOptions {
  /** Model id override for this turn only. Falls back to the orchestrator's
   *  instance-level orchestratorModel field. Set by the /api/chat handler
   *  from the request body's `model` field. */
  orchestratorModel?: string;
  /** Model source override (local | cloud | auto). Falls back to the model
   *  router's persistent setting. */
  modelSource?: 'local' | 'cloud' | 'auto';
  /** Team-member + guide-agent attribution for this turn. Used by the
   *  deliverables recorder to stamp `for_team_member_id` / produced-by
   *  fields. Replaces the setChatActor + finally-clear pattern that races
   *  with concurrent dispatches. Pass `null` to explicitly clear (no
   *  attribution); omit to fall back to the instance field. */
  chatActor?: { teamMemberId: string | null; guideAgentId: string | null } | null;
  /** Cloud-bridge persona hint. The route handler still calls
   *  activateConversationPersona() before dispatch — this field lets the
   *  orchestrator double-check or re-resolve if needed. */
  personaAgentId?: string | null;
  /** Channel-specific options (existing shape, kept separate from the
   *  per-turn snapshot fields so callers like chatForChannel can still
   *  pass it via the runChat() second arg). */
  channel?: ChannelChatOptions;
  /** Optional structured trace id for log correlation. The route handler
   *  populates this from the conversation id so every log line in this
   *  turn can be grep'd by chatTraceId. Bug #6 observability (fix 6d). */
  chatTraceId?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const MODEL = 'claude-haiku-4-5-20251001';
export const MAX_ITERATIONS = 10;
export const MAX_ACTIVE_MEMORIES = 30;

export const MEMORY_EXTRACTION_PROMPT = `You are a memory extraction system for an AI orchestrator. Analyze the conversation and extract reusable learnings about the user.

Types:
- "preference": How the user likes things done (communication style, tone, format)
- "pattern": Recurring workflows or frequent request types
- "context": Business facts, team info, or domain knowledge mentioned
- "correction": Things the user pushed back on or corrected
- "episodic": A specific interaction worth remembering (what happened, what worked or didn't). Format: "When [situation], I [action] and [outcome]."

Respond with ONLY a JSON array of objects with "type" and "content" fields. Extract 0-4 memories max. Skip anything generic or already known.`;

// ============================================================================
// UTILITIES
// ============================================================================

/** Strip <think>...</think> blocks that qwen3 models emit. */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Streaming-compatible filter that suppresses <think>...</think> blocks
 * as tokens arrive. Handles tags split across multiple tokens.
 */
export class ThinkTagFilter {
  private insideThink = false;
  private buffer = '';

  /** Feed a token and return the filtered output (empty string if suppressed). */
  feed(token: string): string {
    let result = '';
    this.buffer += token;

    while (this.buffer.length > 0) {
      if (this.insideThink) {
        // Look for closing </think>
        const closeIdx = this.buffer.indexOf('</think>');
        if (closeIdx !== -1) {
          // Skip everything up to and including </think>
          this.buffer = this.buffer.slice(closeIdx + 8);
          this.insideThink = false;
        } else {
          // Might have a partial </think> at the end — keep buffered
          const partialClose = this.findPartialSuffix(this.buffer, '</think>');
          if (partialClose > 0) {
            // Discard everything before the partial match (it's inside <think>)
            this.buffer = this.buffer.slice(this.buffer.length - partialClose);
          } else {
            this.buffer = '';
          }
          break;
        }
      } else {
        // Look for opening <think>
        const openIdx = this.buffer.indexOf('<think>');
        if (openIdx !== -1) {
          // Emit everything before <think>
          result += this.buffer.slice(0, openIdx);
          this.buffer = this.buffer.slice(openIdx + 7);
          this.insideThink = true;
        } else {
          // Check for partial <think> at the end
          const partialOpen = this.findPartialSuffix(this.buffer, '<think>');
          if (partialOpen > 0) {
            // Emit everything except the potential partial tag
            result += this.buffer.slice(0, this.buffer.length - partialOpen);
            this.buffer = this.buffer.slice(this.buffer.length - partialOpen);
            break;
          } else {
            result += this.buffer;
            this.buffer = '';
          }
        }
      }
    }

    return result;
  }

  /** Flush any remaining buffered content at stream end. */
  flush(): string {
    const remaining = this.insideThink ? '' : this.buffer;
    this.buffer = '';
    this.insideThink = false;
    return remaining;
  }

  /**
   * Find the length of the longest suffix of `text` that matches
   * a prefix of `tag`. Returns 0 if no partial match.
   */
  private findPartialSuffix(text: string, tag: string): number {
    const maxLen = Math.min(text.length, tag.length - 1);
    for (let len = maxLen; len >= 1; len--) {
      if (text.endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }
}
