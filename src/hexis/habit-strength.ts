/**
 * Habit Strength — pure functions for computing strength, automaticity, and decay.
 */

import type { AutomaticityLevel, Habit } from './types.js';
import { AUTOMATICITY_THRESHOLDS, DEFAULT_DECAY_RATE } from './types.js';

/**
 * Compute habit strength from execution history and recency.
 * Base strength increases with execution count and success rate,
 * then decays exponentially with days since last use.
 *
 * @returns strength in range 0-1
 */
export function computeStrength(
  executionCount: number,
  successRate: number,
  daysSinceLastUse: number,
  decayRate: number = DEFAULT_DECAY_RATE,
): number {
  const base = Math.min(1, executionCount / 20) * successRate;
  const decayed = base * Math.exp(-decayRate * daysSinceLastUse);
  return Math.max(0, Math.min(1, decayed));
}

/**
 * Determine automaticity level based on strength, execution count, and success rate.
 */
export function computeAutomaticity(
  strength: number,
  executionCount: number,
  successRate: number,
): AutomaticityLevel {
  if (
    strength >= AUTOMATICITY_THRESHOLDS.automatic &&
    executionCount >= AUTOMATICITY_THRESHOLDS.automaticCount &&
    successRate >= AUTOMATICITY_THRESHOLDS.automaticSuccessRate
  ) {
    return 'automatic';
  }

  if (
    strength >= AUTOMATICITY_THRESHOLDS.semiAutomatic &&
    executionCount >= AUTOMATICITY_THRESHOLDS.semiAutomaticCount
  ) {
    return 'semi_automatic';
  }

  return 'deliberate';
}

/**
 * Apply time-based decay to a habit's strength.
 * Returns the new strength value (does not mutate the habit).
 */
export function decayHabitStrength(habit: Habit, daysSinceLastUse: number): number {
  return computeStrength(
    habit.executionCount,
    habit.successRate,
    daysSinceLastUse,
    habit.decayRate,
  );
}
