/**
 * Difficulty Scorer — Heuristic task difficulty classification.
 * Routes simple tasks to faster/cheaper models, complex tasks to more capable ones.
 */

export type DifficultyLevel = 'simple' | 'moderate' | 'complex';

const COMPLEXITY_KEYWORDS = [
  'analyze', 'research', 'compare', 'strategy', 'multi-step',
  'investigate', 'evaluate', 'comprehensive', 'detailed', 'in-depth',
  'cross-reference', 'synthesize', 'coordinate', 'integrate', 'negotiate',
];

const SIMPLICITY_KEYWORDS = [
  'list', 'summarize', 'check', 'status', 'update',
  'get', 'fetch', 'show', 'count', 'read',
  'lookup', 'find', 'search', 'view', 'display',
];

export function scoreDifficulty(input: {
  taskDescription: string | null;
  toolCount: number;
  hasIntegrations: boolean;
  hasBrowserTools: boolean;
}): DifficultyLevel {
  let score = 0; // 0 = simple, higher = more complex

  const text = (input.taskDescription || '').toLowerCase();
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Word count signal
  if (wordCount > 200) score += 2;
  else if (wordCount > 100) score += 1;
  else if (wordCount < 50) score -= 1;

  // Tool count signal
  if (input.toolCount >= 6) score += 2;
  else if (input.toolCount >= 3) score += 1;
  else if (input.toolCount <= 2) score -= 1;

  // Integration/browser signals
  if (input.hasIntegrations) score += 1;
  if (input.hasBrowserTools) score += 1;

  // Keyword analysis
  for (const keyword of COMPLEXITY_KEYWORDS) {
    if (text.includes(keyword)) {
      score += 1;
      break; // Only count once
    }
  }

  for (const keyword of SIMPLICITY_KEYWORDS) {
    if (text.includes(keyword)) {
      score -= 1;
      break; // Only count once
    }
  }

  // Map score to difficulty level
  if (score >= 3) return 'complex';
  if (score >= 1) return 'moderate';
  return 'simple';
}
