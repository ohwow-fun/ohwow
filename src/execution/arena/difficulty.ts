/**
 * Arena Difficulty Scaling — Progressive challenge levels
 *
 * Controls arena difficulty by restricting the action space,
 * adjusting step budgets, and setting timeouts. This maps to
 * the existing Affordance system: difficulty = fewer affordances.
 *
 * Inspired by Gym-V's finding that observation scaffolding and
 * environment constraints matter more than algorithm choice.
 */

import type { ArenaConfig } from './types.js';

// ============================================================================
// TYPES
// ============================================================================

export type DifficultyTier = 'easy' | 'medium' | 'hard' | 'expert';

/**
 * A difficulty level configures environment constraints.
 * Higher difficulty = fewer tools, fewer steps, tighter timeouts.
 */
export interface DifficultyLevel {
  /** Difficulty tier name. */
  tier: DifficultyTier;
  /** Maximum steps per episode (overrides arena config). */
  maxSteps: number;
  /** Allowed tools (empty = all tools allowed). */
  allowedTools: string[];
  /** Timeout per step in ms (0 = no timeout). */
  stepTimeoutMs: number;
  /** Optional hints injected into observations. */
  hintFrequency: number; // 0 = no hints, 1 = every step, 0.5 = every other step
}

// ============================================================================
// PRESET DIFFICULTY LEVELS
// ============================================================================

/**
 * Easy: generous step budget, all tools available, no timeout.
 * Good for initial exploration and understanding the environment.
 */
export const EASY: DifficultyLevel = {
  tier: 'easy',
  maxSteps: 50,
  allowedTools: [],
  stepTimeoutMs: 0,
  hintFrequency: 1,
};

/**
 * Medium: moderate step budget, all tools, reasonable timeout.
 * The default training difficulty.
 */
export const MEDIUM: DifficultyLevel = {
  tier: 'medium',
  maxSteps: 30,
  allowedTools: [],
  stepTimeoutMs: 30_000,
  hintFrequency: 0.25,
};

/**
 * Hard: tight step budget, restricted tools, strict timeout.
 * Forces efficient tool usage and planning.
 */
export const HARD: DifficultyLevel = {
  tier: 'hard',
  maxSteps: 15,
  allowedTools: [], // Caller should specify relevant subset
  stepTimeoutMs: 15_000,
  hintFrequency: 0,
};

/**
 * Expert: minimal steps, restricted tools, tight timeout, no hints.
 * Simulates real-world constraints where agents must be decisive.
 */
export const EXPERT: DifficultyLevel = {
  tier: 'expert',
  maxSteps: 8,
  allowedTools: [], // Caller should specify minimal subset
  stepTimeoutMs: 10_000,
  hintFrequency: 0,
};

/** Lookup table for difficulty presets. */
export const DIFFICULTY_PRESETS: Record<DifficultyTier, DifficultyLevel> = {
  easy: EASY,
  medium: MEDIUM,
  hard: HARD,
  expert: EXPERT,
};

// ============================================================================
// SCALING FUNCTIONS
// ============================================================================

/**
 * Apply a difficulty level to an arena config.
 * Returns a new config with constraints from the difficulty level.
 * The original config's rewardFn, initialState, and successCriteria are preserved.
 */
export function scaleDifficulty(
  arena: ArenaConfig,
  level: DifficultyLevel,
): ArenaConfig {
  return {
    ...arena,
    id: `${arena.id}@${level.tier}`,
    name: `${arena.name} (${level.tier})`,
    maxSteps: level.maxSteps,
    allowedTools: level.allowedTools.length > 0
      ? level.allowedTools
      : arena.allowedTools, // Keep original if level doesn't restrict
    stepTimeoutMs: level.stepTimeoutMs || arena.stepTimeoutMs,
  };
}

/**
 * Generate a progressive curriculum: same arena at increasing difficulty.
 * Returns configs from easy to expert (or a custom subset of tiers).
 */
export function progressiveDifficulty(
  arena: ArenaConfig,
  tiers: DifficultyTier[] = ['easy', 'medium', 'hard', 'expert'],
  toolSubsets?: Partial<Record<DifficultyTier, string[]>>,
): ArenaConfig[] {
  return tiers.map(tier => {
    const level = { ...DIFFICULTY_PRESETS[tier] };
    if (toolSubsets?.[tier]) {
      level.allowedTools = toolSubsets[tier]!;
    }
    return scaleDifficulty(arena, level);
  });
}

/**
 * Auto-select difficulty based on agent performance history.
 * Uses a simple threshold: if success rate > 70%, increase difficulty.
 * If success rate < 30%, decrease difficulty.
 */
export function autoSelectDifficulty(
  successRate: number,
  currentTier: DifficultyTier,
): DifficultyTier {
  const tiers: DifficultyTier[] = ['easy', 'medium', 'hard', 'expert'];
  const currentIndex = tiers.indexOf(currentTier);

  if (successRate > 0.7 && currentIndex < tiers.length - 1) {
    return tiers[currentIndex + 1];
  }
  if (successRate < 0.3 && currentIndex > 0) {
    return tiers[currentIndex - 1];
  }
  return currentTier;
}
