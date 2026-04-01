/**
 * Creative dreaming — runs during REM phase.
 * Generates novel associations between memories from different domains.
 * Jung's active imagination: the unconscious recombines what consciousness cannot.
 */

import type { DreamAssociation } from './types.js';

export interface DreamMemory {
  id: string;
  content: string;
  keywords?: string[];
}

/**
 * Generate novel associations by pairing memories from different domains.
 * Novelty is scored by inverse keyword overlap: the more different, the more novel.
 */
export function generateDreamAssociations(
  memories: DreamMemory[],
  count: number,
): DreamAssociation[] {
  if (memories.length < 2) return [];

  const associations: DreamAssociation[] = [];
  const now = Date.now();

  // Build all cross-domain pairs
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i];
      const b = memories[j];

      const keywordsA = new Set(a.keywords ?? []);
      const keywordsB = new Set(b.keywords ?? []);

      // Skip if same domain (high overlap)
      if (keywordsA.size > 0 && keywordsB.size > 0) {
        const intersection = [...keywordsA].filter((k) => keywordsB.has(k));
        const union = new Set([...keywordsA, ...keywordsB]);

        // Jaccard similarity: intersection / union
        const similarity = union.size > 0 ? intersection.length / union.size : 0;
        const noveltyScore = 1 - similarity;

        // Only keep genuinely cross-domain pairs (novelty > 0.5)
        if (noveltyScore <= 0.5) continue;

        const domainA = [...keywordsA].filter((k) => !keywordsB.has(k)).join(', ') || 'unknown';
        const domainB = [...keywordsB].filter((k) => !keywordsA.has(k)).join(', ') || 'unknown';

        const connection =
          intersection.length > 0
            ? `Both relate to ${intersection.join(', ')}`
            : `Unexpected link between ${domainA} and ${domainB}`;

        associations.push({
          id: `dream-${now}-${i}-${j}`,
          memoryA: { id: a.id, content: a.content },
          memoryB: { id: b.id, content: b.content },
          connection,
          noveltyScore,
          promoted: false,
          timestamp: now,
        });
      } else {
        // No keywords on one or both: treat as fully novel
        associations.push({
          id: `dream-${now}-${i}-${j}`,
          memoryA: { id: a.id, content: a.content },
          memoryB: { id: b.id, content: b.content },
          connection: `Unexpected link between ${a.content.slice(0, 30)} and ${b.content.slice(0, 30)}`,
          noveltyScore: 1.0,
          promoted: false,
          timestamp: now,
        });
      }
    }
  }

  // Sort by novelty descending, return top `count`
  associations.sort((a, b) => b.noveltyScore - a.noveltyScore);
  return associations.slice(0, count);
}
