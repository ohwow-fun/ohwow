/**
 * Bad Habit Detector — identifies habits that should be unlearned or revised.
 * Pure function: no side effects, no DB access.
 */

import type { Habit, BadHabitIndicator } from './types.js';

/**
 * Detect habits that show signs of being counterproductive.
 * Only flags habits with strength > 0.3 (strong enough to be worth noticing).
 */
export function detectBadHabits(habits: Habit[]): BadHabitIndicator[] {
  const indicators: BadHabitIndicator[] = [];

  for (const habit of habits) {
    if (habit.strength <= 0.3) continue;

    // Declining success: current success rate dropped significantly
    if (habit.executionCount >= 5 && habit.successRate < 0.5) {
      indicators.push({
        habitId: habit.id,
        habitName: habit.name,
        reason: 'declining_success',
        evidence: `Success rate is ${(habit.successRate * 100).toFixed(0)}% over ${habit.executionCount} executions`,
        recommendation: `Review and adjust "${habit.name}" routine, or let it decay naturally`,
      });
    }

    // Context changed: habit hasn't been triggered in 30+ days
    if (habit.lastExecuted) {
      const lastUsed = new Date(habit.lastExecuted).getTime();
      const now = Date.now();
      const daysSinceUse = (now - lastUsed) / (1000 * 60 * 60 * 24);

      if (daysSinceUse > 30) {
        indicators.push({
          habitId: habit.id,
          habitName: habit.name,
          reason: 'context_changed',
          evidence: `Not triggered in ${Math.round(daysSinceUse)} days`,
          recommendation: `Consider archiving "${habit.name}" as the context may have changed`,
        });
      }
    }

    // Excessive cost: stub for future cost tracking
    // Will be implemented when per-tool cost metrics are available
  }

  return indicators;
}
