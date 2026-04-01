/**
 * Default Mode Network — background processing during any idle period.
 * Spontaneous insight generation and future simulation.
 * Based on DMN research: the brain's most creative processing happens at rest.
 */

import type { DefaultModeInsight } from './types.js';

export interface DMNPattern {
  name: string;
  description: string;
}

export interface DMNPrinciple {
  rule: string;
  category: string;
}

export interface DMNGoal {
  title: string;
  currentValue: number;
  targetValue: number;
}

/**
 * Find connections between observed patterns and distilled principles.
 * Returns a spontaneous insight if a meaningful connection is found.
 */
export function generateSpontaneousInsight(
  patterns: DMNPattern[],
  principles: DMNPrinciple[],
): DefaultModeInsight | null {
  if (patterns.length === 0 || principles.length === 0) return null;

  // Pick a random pattern and look for keyword overlap with principles
  const pattern = patterns[Math.floor(Math.random() * patterns.length)];
  const patternWords = new Set(
    pattern.description.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
  );

  let bestPrinciple: DMNPrinciple | null = null;
  let bestOverlap = 0;

  for (const principle of principles) {
    const principleWords = principle.rule.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const overlap = principleWords.filter((w) => patternWords.has(w)).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestPrinciple = principle;
    }
  }

  if (!bestPrinciple || bestOverlap === 0) {
    // No keyword overlap found; pick random principle for creative recombination
    bestPrinciple = principles[Math.floor(Math.random() * principles.length)];
    return {
      type: 'creative_recombination',
      content: `Pattern "${pattern.name}" might connect to principle "${bestPrinciple.rule}" in category ${bestPrinciple.category}`,
      confidence: 0.3,
      relatedMemoryIds: [],
      timestamp: Date.now(),
    };
  }

  return {
    type: 'spontaneous_insight',
    content: `Pattern "${pattern.name}" aligns with principle "${bestPrinciple.rule}" (${bestPrinciple.category}). The pattern ${pattern.description.toLowerCase()} reinforces this rule.`,
    confidence: Math.min(0.9, 0.3 + bestOverlap * 0.15),
    relatedMemoryIds: [],
    timestamp: Date.now(),
  };
}

/**
 * Simple future simulation: project goal progress based on recent trends.
 */
export function simulateFuture(
  goals: DMNGoal[],
  recentTrends: string[],
): DefaultModeInsight | null {
  if (goals.length === 0) return null;

  const goal = goals[Math.floor(Math.random() * goals.length)];
  const progress = goal.currentValue / goal.targetValue;
  const remaining = goal.targetValue - goal.currentValue;

  if (progress >= 1) {
    return {
      type: 'future_simulation',
      content: `Goal "${goal.title}" has been reached (${goal.currentValue}/${goal.targetValue}).`,
      confidence: 0.9,
      relatedMemoryIds: [],
      timestamp: Date.now(),
    };
  }

  // Check if any trend mentions this goal negatively
  const negativeTrend = recentTrends.find(
    (t) => t.toLowerCase().includes(goal.title.toLowerCase()) && t.toLowerCase().includes('declin'),
  );

  if (negativeTrend) {
    return {
      type: 'future_simulation',
      content: `Risk: "${goal.title}" trending away from target. Current: ${goal.currentValue}, target: ${goal.targetValue}. Recent trend: ${negativeTrend}`,
      confidence: 0.6,
      relatedMemoryIds: [],
      timestamp: Date.now(),
    };
  }

  const progressPct = Math.round(progress * 100);
  return {
    type: 'future_simulation',
    content: `At current rate, "${goal.title}" is ${progressPct}% complete (${goal.currentValue}/${goal.targetValue}). ${remaining} remaining to target.`,
    confidence: 0.5,
    relatedMemoryIds: [],
    timestamp: Date.now(),
  };
}
