/**
 * Shadow Detection — Universal Blind Spot Identification
 *
 * Jung: "Until you make the unconscious conscious, it will direct your
 * life and you will call it fate."
 *
 * Shadows are not flaws to fix. They are patterns the entity cannot see
 * about itself, revealed only through recurring friction. This module
 * detects them compassionately, not judgmentally.
 */

import type { ShadowCategory, ShadowPattern } from './types.js';

/**
 * Extract lowercase words from a string, filtering noise.
 */
function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

/**
 * Compute word overlap ratio between two word sets.
 * Returns 0-1 where 1 means identical word sets.
 */
function wordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const shared = b.filter((w) => setA.has(w)).length;
  return shared / Math.max(a.length, b.length);
}

/**
 * Classify a group of patterns into a shadow category based on keywords.
 */
function classifyGroup(patterns: string[]): ShadowCategory {
  const combined = patterns.join(' ').toLowerCase();

  const skillWords = ['tool', 'skill', 'ability', 'capability', 'unable', 'cannot', 'missing', 'lack'];
  const valueWords = ['expect', 'should', 'wrong', 'disagree', 'mismatch', 'priority', 'goal'];
  const overconfidenceWords = ['overestimate', 'confident', 'assumed', 'thought', 'easy', 'simple', 'underestimate'];
  const behaviorWords = ['again', 'repeat', 'always', 'keeps', 'pattern', 'habit', 'tendency', 'often'];

  const scores: Array<[ShadowCategory, number]> = [
    ['skill_gap', skillWords.filter((w) => combined.includes(w)).length],
    ['value_mismatch', valueWords.filter((w) => combined.includes(w)).length],
    ['overconfidence', overconfidenceWords.filter((w) => combined.includes(w)).length],
    ['behavioral_pattern', behaviorWords.filter((w) => combined.includes(w)).length],
  ];

  scores.sort((a, b) => b[1] - a[1]);

  // Default to behavioral_pattern if no keywords match
  if (scores[0][1] === 0) return 'behavioral_pattern';
  return scores[0][0];
}

/**
 * Group patterns by keyword similarity, then classify each group
 * as a shadow pattern. Only groups with 3+ occurrences surface as shadows.
 */
export function detectShadows(
  negativePatterns: string[],
  failureCategories: string[]
): ShadowPattern[] {
  const allPatterns = [...negativePatterns, ...failureCategories];
  if (allPatterns.length === 0) return [];

  // Extract words for each pattern
  const patternWords = allPatterns.map(extractWords);

  // Greedy clustering by word overlap
  const assigned = new Set<number>();
  const groups: number[][] = [];

  for (let i = 0; i < allPatterns.length; i++) {
    if (assigned.has(i)) continue;

    const group = [i];
    assigned.add(i);

    for (let j = i + 1; j < allPatterns.length; j++) {
      if (assigned.has(j)) continue;
      if (wordOverlap(patternWords[i], patternWords[j]) >= 0.3) {
        group.push(j);
        assigned.add(j);
      }
    }

    groups.push(group);
  }

  // Convert groups with 3+ members into shadow patterns
  const shadows: ShadowPattern[] = [];
  const now = new Date().toISOString();

  for (const group of groups) {
    if (group.length < 3) continue;

    const groupTexts = group.map((i) => allPatterns[i]);
    const category = classifyGroup(groupTexts);

    // Build description from the most representative pattern (longest)
    const representative = groupTexts.reduce((a, b) =>
      a.length >= b.length ? a : b
    );

    shadows.push({
      description: representative,
      confidence: Math.min(0.95, 0.5 + group.length * 0.1),
      occurrences: group.length,
      category,
      firstSeen: now,
    });
  }

  return shadows;
}
