/**
 * Memory consolidation — runs during deep_sleep.
 * Selects, prunes, and strengthens memories based on relevance, recency, and affect.
 */

export interface ConsolidationMemory {
  id: string;
  content: string;
  relevanceScore: number;  // 0-1
  timesUsed: number;
  createdAt: number;       // epoch ms
  affect?: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Select memories for consolidation, ranked by composite score.
 * Relevance (40%) + recency (30%) + emotional weight (30%).
 */
export function selectForConsolidation(
  memories: ConsolidationMemory[],
  limit: number,
): ConsolidationMemory[] {
  const now = Date.now();
  const maxAge = Math.max(
    ...memories.map((m) => now - m.createdAt),
    1, // avoid division by zero
  );

  const scored = memories.map((m) => {
    const recency = 1 - (now - m.createdAt) / maxAge;
    const emotionalWeight = m.affect ? 0.2 : 0;
    const score = m.relevanceScore * 0.4 + recency * 0.3 + emotionalWeight * 0.3;
    return { memory: m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.memory);
}

/**
 * Identify memories safe to prune.
 * Prune if relevanceScore < threshold AND never used AND older than 7 days.
 */
export function identifyForPruning(
  memories: ConsolidationMemory[],
  threshold: number,
): string[] {
  const now = Date.now();
  return memories
    .filter(
      (m) =>
        m.relevanceScore < threshold &&
        m.timesUsed === 0 &&
        now - m.createdAt > SEVEN_DAYS_MS,
    )
    .map((m) => m.id);
}

/**
 * Identify memories to strengthen.
 * Strengthen if frequently used (>3) or high relevance (>0.8).
 */
export function identifyForStrengthening(
  memories: ConsolidationMemory[],
): string[] {
  return memories
    .filter((m) => m.timesUsed > 3 || m.relevanceScore > 0.8)
    .map((m) => m.id);
}
