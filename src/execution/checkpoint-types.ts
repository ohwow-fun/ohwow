/**
 * Agent Checkpointing — Types (Local Runtime)
 * Data structures for saving and restoring agent execution state.
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';

/**
 * Serializable checkpoint of a task execution.
 */
export interface TaskCheckpoint {
  version: 1;
  messages: MessageParam[];
  iteration: number;
  toolCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolCallHashes: string[];
  elapsedMs: number;
  savedAt: string;
  reason: 'pause_requested' | 'duration_limit' | 'crash_recovery' | 'iteration_save';
}

/**
 * Serialize a checkpoint to JSON string, with size safety.
 */
export function serializeCheckpoint(checkpoint: TaskCheckpoint, maxBytes = 512_000): string {
  let json = JSON.stringify(checkpoint);

  if (json.length <= maxBytes) return json;

  const msgs = [...checkpoint.messages];
  while (json.length > maxBytes && msgs.length > 8) {
    msgs.splice(1, 1);
    json = JSON.stringify({ ...checkpoint, messages: msgs });
  }

  return json;
}
