/**
 * Experience Stream — Process Ontology (Whitehead)
 *
 * "The process is the reality." — A.N. Whitehead
 *
 * Everything that happens in the brain is an Experience. The brain
 * is not a data store; it is a stream of experiences flowing through time.
 *
 * This module replaces the scattered state tracking across the orchestrator
 * and engine (toolCallHashes arrays, executedToolCalls Maps, token counters)
 * with a unified, append-only event log that all brain modules read from.
 *
 * Design:
 * - Ring buffer (bounded memory, no unbounded growth)
 * - Queryable by type, time range, source
 * - The single source of truth for predictive engine, temporal frame, self-model
 * - Optionally persists to DB for cross-session learning
 */

import crypto from 'crypto';
import type { Experience, ExperienceType, StimulusSource } from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default ring buffer capacity. */
const DEFAULT_CAPACITY = 1000;

/** How many experiences to batch before flushing to persistence. */
const PERSISTENCE_BATCH_SIZE = 50;

// ============================================================================
// QUERY INTERFACE
// ============================================================================

/** Filter for querying the experience stream. */
export interface ExperienceFilter {
  /** Only return experiences of these types. */
  types?: ExperienceType[];
  /** Only return experiences from these sources. */
  sources?: StimulusSource[];
  /** Only return experiences after this timestamp. */
  after?: number;
  /** Only return experiences before this timestamp. */
  before?: number;
  /** Maximum number of results. */
  limit?: number;
}

/** Callback for real-time experience listeners. */
export type ExperienceListener = (experience: Experience) => void;

/** Optional persistence adapter for cross-session learning. */
export interface ExperiencePersistence {
  flush(experiences: Experience[]): Promise<void>;
}

// ============================================================================
// EXPERIENCE STREAM
// ============================================================================

/**
 * The ExperienceStream is the brain's process log.
 *
 * Every tool call, prediction, error, insight, and memory extraction
 * is an Experience. The stream provides:
 *
 * 1. **Unified state**: replaces orchToolCallHashes, executedToolCalls, etc.
 * 2. **Temporal queries**: "what happened in the last 5 seconds?"
 * 3. **Pattern detection**: "how often does scrape_url fail?"
 * 4. **Causal chains**: "what caused this stagnation?"
 * 5. **Real-time listeners**: brain modules subscribe to experience types
 */
export class ExperienceStream {
  private buffer: Experience[];
  private capacity: number;
  private writeIndex: number = 0;
  private totalCount: number = 0;
  private listeners: Map<string, ExperienceListener[]> = new Map();
  private persistenceBuffer: Experience[] = [];
  private persistence: ExperiencePersistence | null;

  constructor(options?: {
    capacity?: number;
    persistence?: ExperiencePersistence;
  }) {
    this.capacity = options?.capacity ?? DEFAULT_CAPACITY;
    this.buffer = new Array(this.capacity);
    this.persistence = options?.persistence ?? null;
  }

  // --------------------------------------------------------------------------
  // WRITE
  // --------------------------------------------------------------------------

  /**
   * Append a new experience to the stream.
   * This is the primary write operation — all brain modules call this.
   */
  append(
    type: ExperienceType,
    data: unknown,
    source: StimulusSource,
    causalPredecessor?: string,
  ): Experience {
    const experience: Experience = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type,
      data,
      source,
      causalPredecessor,
    };

    // Write to ring buffer (overwrites oldest when full)
    this.buffer[this.writeIndex] = experience;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.totalCount++;

    // Notify listeners
    this.notifyListeners(experience);

    // Batch for persistence
    if (this.persistence) {
      this.persistenceBuffer.push(experience);
      if (this.persistenceBuffer.length >= PERSISTENCE_BATCH_SIZE) {
        const batch = this.persistenceBuffer.splice(0);
        this.persistence.flush(batch).catch(() => {
          // Non-critical: persistence failure doesn't block the brain
        });
      }
    }

    return experience;
  }

  // --------------------------------------------------------------------------
  // READ
  // --------------------------------------------------------------------------

  /**
   * Get the most recent N experiences.
   */
  getRecent(n: number): Experience[] {
    const count = Math.min(n, this.size());
    const result: Experience[] = [];

    for (let i = 0; i < count; i++) {
      const idx = ((this.writeIndex - 1 - i) % this.capacity + this.capacity) % this.capacity;
      const exp = this.buffer[idx];
      if (exp) result.push(exp);
    }

    return result.reverse(); // chronological order
  }

  /**
   * Query experiences by filter.
   */
  query(filter: ExperienceFilter): Experience[] {
    const results: Experience[] = [];
    const limit = filter.limit ?? this.size();
    const count = this.size();

    // Iterate from newest to oldest
    for (let i = 0; i < count && results.length < limit; i++) {
      const idx = ((this.writeIndex - 1 - i) % this.capacity + this.capacity) % this.capacity;
      const exp = this.buffer[idx];
      if (!exp) continue;

      if (filter.types && !filter.types.includes(exp.type)) continue;
      if (filter.sources && !filter.sources.includes(exp.source)) continue;
      if (filter.after && exp.timestamp < filter.after) continue;
      if (filter.before && exp.timestamp > filter.before) continue;

      results.push(exp);
    }

    return results.reverse(); // chronological order
  }

  /**
   * Count experiences matching a filter.
   * Useful for statistics without materializing results.
   */
  count(filter: ExperienceFilter): number {
    let count = 0;
    const total = this.size();

    for (let i = 0; i < total; i++) {
      const idx = ((this.writeIndex - 1 - i) % this.capacity + this.capacity) % this.capacity;
      const exp = this.buffer[idx];
      if (!exp) continue;

      if (filter.types && !filter.types.includes(exp.type)) continue;
      if (filter.sources && !filter.sources.includes(exp.source)) continue;
      if (filter.after && exp.timestamp < filter.after) continue;
      if (filter.before && exp.timestamp > filter.before) continue;

      count++;
    }

    return count;
  }

  /**
   * Get a causal chain: follow causalPredecessor links backward from an experience.
   */
  getCausalChain(experienceId: string, maxDepth: number = 10): Experience[] {
    const chain: Experience[] = [];
    let currentId: string | undefined = experienceId;
    let depth = 0;

    while (currentId && depth < maxDepth) {
      const found = this.findById(currentId);
      if (!found) break;
      chain.push(found);
      currentId = found.causalPredecessor;
      depth++;
    }

    return chain.reverse(); // root cause first
  }

  // --------------------------------------------------------------------------
  // STATISTICS — for PredictiveEngine and SelfModel
  // --------------------------------------------------------------------------

  /**
   * Compute success rate for a specific tool from recent experiences.
   */
  getToolSuccessRate(toolName: string, windowMs?: number): { rate: number; total: number } {
    const after = windowMs ? Date.now() - windowMs : undefined;
    const executions = this.query({
      types: ['tool_executed'],
      after,
    });

    let successes = 0;
    let total = 0;

    for (const exp of executions) {
      const data = exp.data as { toolName: string; success: boolean } | undefined;
      if (data?.toolName === toolName) {
        total++;
        if (data.success) successes++;
      }
    }

    return { rate: total > 0 ? successes / total : 0.5, total };
  }

  /**
   * Get the last N tool executions (for stagnation detection).
   */
  getRecentToolExecutions(n: number): Array<{ toolName: string; inputHash: string; success: boolean }> {
    const executions = this.query({
      types: ['tool_executed'],
      limit: n,
    });

    return executions.map(exp => {
      const data = exp.data as { toolName: string; inputHash: string; success: boolean };
      return { toolName: data.toolName, inputHash: data.inputHash, success: data.success };
    });
  }

  /**
   * Get prediction accuracy from recent prediction errors.
   */
  getPredictionAccuracy(windowMs?: number): number {
    const after = windowMs ? Date.now() - windowMs : undefined;
    const errors = this.query({ types: ['prediction_error'], after });

    if (errors.length === 0) return 0.5; // no data = maximum uncertainty

    const totalDelta = errors.reduce((sum, exp) => {
      const data = exp.data as { delta: number } | undefined;
      return sum + (data?.delta ?? 0.5);
    }, 0);

    // Accuracy = 1 - average error delta
    return 1 - (totalDelta / errors.length);
  }

  // --------------------------------------------------------------------------
  // LISTENERS
  // --------------------------------------------------------------------------

  /**
   * Subscribe to experiences of specific types.
   * Returns an unsubscribe function.
   */
  on(type: ExperienceType | '*', listener: ExperienceListener): () => void {
    const key = type;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, []);
    }
    this.listeners.get(key)!.push(listener);

    return () => {
      const listeners = this.listeners.get(key);
      if (listeners) {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      }
    };
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  /** Current number of experiences in the buffer. */
  size(): number {
    return Math.min(this.totalCount, this.capacity);
  }

  /** Total experiences ever appended (including overwritten). */
  totalExperiences(): number {
    return this.totalCount;
  }

  /** Flush any remaining persistence buffer. */
  async flush(): Promise<void> {
    if (this.persistence && this.persistenceBuffer.length > 0) {
      const batch = this.persistenceBuffer.splice(0);
      await this.persistence.flush(batch);
    }
  }

  private findById(id: string): Experience | undefined {
    const count = this.size();
    for (let i = 0; i < count; i++) {
      const idx = ((this.writeIndex - 1 - i) % this.capacity + this.capacity) % this.capacity;
      const exp = this.buffer[idx];
      if (exp?.id === id) return exp;
    }
    return undefined;
  }

  private notifyListeners(experience: Experience): void {
    // Type-specific listeners
    const typeListeners = this.listeners.get(experience.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try { listener(experience); } catch { /* listener errors are non-fatal */ }
      }
    }

    // Wildcard listeners
    const wildcardListeners = this.listeners.get('*');
    if (wildcardListeners) {
      for (const listener of wildcardListeners) {
        try { listener(experience); } catch { /* listener errors are non-fatal */ }
      }
    }
  }
}
