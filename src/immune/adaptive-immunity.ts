/**
 * Adaptive Immunity — Learned threat memory and response tuning
 * Builds memory of past threats to improve future detection.
 */

import type { ImmuneMemory, PathogenType } from './types.js';

/**
 * Check if a context hash matches any existing immune memory.
 * Returns the matching memory if found, null otherwise.
 */
export function matchImmuneMemory(
  contextHash: string,
  memories: ImmuneMemory[],
): ImmuneMemory | null {
  return memories.find(m => m.contextHash === contextHash) ?? null;
}

/**
 * Create or strengthen an immune memory for a threat.
 * If a memory with the same contextHash exists, increment occurrences.
 * Otherwise, create a new memory entry.
 */
export function learnThreat(
  pathogenType: PathogenType,
  contextHash: string,
  memories: ImmuneMemory[],
): ImmuneMemory[] {
  const existing = memories.find(m => m.contextHash === contextHash);

  if (existing) {
    return memories.map(m =>
      m.contextHash === contextHash
        ? {
            ...m,
            occurrences: m.occurrences + 1,
            lastOccurrence: new Date().toISOString(),
          }
        : m
    );
  }

  const newMemory: ImmuneMemory = {
    id: generateId(),
    pathogenType,
    contextHash,
    occurrences: 1,
    lastOccurrence: new Date().toISOString(),
    responseEffectiveness: 0.5, // neutral starting point
  };

  return [...memories, newMemory];
}

/**
 * Update the response effectiveness score for a memory.
 * Moves toward 1.0 when threats are successfully blocked,
 * toward 0.0 when they slip through.
 */
export function computeResponseEffectiveness(
  memory: ImmuneMemory,
  wasBlocked: boolean,
): ImmuneMemory {
  const learningRate = 0.2;
  const target = wasBlocked ? 1.0 : 0.0;
  const newEffectiveness = memory.responseEffectiveness + learningRate * (target - memory.responseEffectiveness);

  return {
    ...memory,
    responseEffectiveness: Math.max(0, Math.min(1, newEffectiveness)),
  };
}

function generateId(): string {
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('');
}
