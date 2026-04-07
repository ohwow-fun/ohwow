/**
 * Topological Sort for Sequential Execution (Local Runtime)
 *
 * Groups items with dependency edges into "waves" that can run in parallel.
 * Items in the same wave have all dependencies satisfied.
 * Waves execute sequentially; items within a wave execute concurrently.
 */

import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface Sortable {
  id: string;
  dependsOn: string[];
}

// ============================================================================
// TOPOLOGICAL SORT
// ============================================================================

export function topologicalSort<T extends Sortable>(items: T[]): T[][] {
  if (items.length === 0) return [];

  const waves: T[][] = [];
  const completed = new Set<string>();
  let remaining = [...items];

  const maxIterations = items.length;

  for (let i = 0; i < maxIterations && remaining.length > 0; i++) {
    const ready = remaining.filter((item) =>
      item.dependsOn.every((dep) => completed.has(dep))
    );

    if (ready.length === 0) {
      logger.warn(
        { remaining: remaining.map((item) => item.id) },
        'Breaking circular dependency in sequence graph'
      );
      waves.push(remaining);
      break;
    }

    waves.push(ready);
    for (const item of ready) {
      completed.add(item.id);
    }
    remaining = remaining.filter((item) => !completed.has(item.id));
  }

  return waves;
}
