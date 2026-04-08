/**
 * Savepoint Store — In-Memory Named Checkpoints (Local Runtime)
 *
 * Stores named execution savepoints during task execution.
 * Ring buffer (max 5) prevents memory bloat.
 *
 * Mirror of ohwow.fun/src/lib/agents/tool-loop/savepoint-store.ts
 * adapted for the local runtime's MessageParam type.
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';

// ============================================================================
// TYPES
// ============================================================================

export interface SavepointData {
  messages: MessageParam[];
  iteration: number;
  toolCallHashes: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface SavepointInfo {
  name: string;
  reason: string;
  iteration: number;
  savedAt: string;
}

interface StoredSavepoint {
  name: string;
  reason: string;
  data: SavepointData;
  savedAt: string;
}

// ============================================================================
// STORE
// ============================================================================

export class SavepointStore {
  private savepoints: Map<string, StoredSavepoint> = new Map();
  private insertionOrder: string[] = [];
  private readonly maxSavepoints: number;

  constructor(maxSavepoints = 5) {
    this.maxSavepoints = maxSavepoints;
  }

  create(name: string, reason: string, data: SavepointData): void {
    if (this.savepoints.size >= this.maxSavepoints && !this.savepoints.has(name)) {
      const oldest = this.insertionOrder.shift();
      if (oldest) this.savepoints.delete(oldest);
    }

    const snapshot: StoredSavepoint = {
      name,
      reason,
      data: {
        messages: JSON.parse(JSON.stringify(data.messages)),
        iteration: data.iteration,
        toolCallHashes: [...data.toolCallHashes],
        totalInputTokens: data.totalInputTokens,
        totalOutputTokens: data.totalOutputTokens,
      },
      savedAt: new Date().toISOString(),
    };

    if (this.savepoints.has(name)) {
      this.insertionOrder = this.insertionOrder.filter((n) => n !== name);
    }

    this.savepoints.set(name, snapshot);
    this.insertionOrder.push(name);
  }

  rollbackTo(name: string): SavepointData | null {
    const sp = this.savepoints.get(name);
    if (!sp) return null;

    return {
      messages: JSON.parse(JSON.stringify(sp.data.messages)),
      iteration: sp.data.iteration,
      toolCallHashes: [...sp.data.toolCallHashes],
      totalInputTokens: sp.data.totalInputTokens,
      totalOutputTokens: sp.data.totalOutputTokens,
    };
  }

  list(): SavepointInfo[] {
    return this.insertionOrder.map((name) => {
      const sp = this.savepoints.get(name)!;
      return {
        name: sp.name,
        reason: sp.reason,
        iteration: sp.data.iteration,
        savedAt: sp.savedAt,
      };
    });
  }

  has(name: string): boolean {
    return this.savepoints.has(name);
  }

  get size(): number {
    return this.savepoints.size;
  }
}
