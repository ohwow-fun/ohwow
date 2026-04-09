/**
 * Sparse Reward Functions — Task-level signals
 *
 * Sparse rewards fire only on specific events (goal reached, time expired).
 * They provide no intermediate signal, which makes them harder to learn from
 * but more accurate as success measures.
 *
 * Use compositeReward() from ../reward.ts to combine with shaped rewards
 * for the best of both worlds.
 */

import type { Observation, RewardFunction } from '../types.js';

/**
 * Binary goal reward: +1 on first success, 0 otherwise.
 * Only fires once per episode to avoid reward hacking.
 */
export function goalReward(
  isGoalReached: (obs: Observation) => boolean,
): RewardFunction {
  let fired = false;
  return (obs: Observation) => {
    if (fired) return 0;
    if (isGoalReached(obs)) {
      fired = true;
      return 1.0;
    }
    return 0;
  };
}

/**
 * Deadline reward: scaled +1 if goal is reached before the deadline.
 * Faster completion = higher reward. If deadline passes, returns 0.
 */
export function deadlineReward(
  maxMs: number,
  isGoalReached: (obs: Observation) => boolean,
): RewardFunction {
  const start = Date.now();
  let fired = false;
  return (obs: Observation) => {
    if (fired) return 0;
    if (!isGoalReached(obs)) return 0;
    fired = true;
    const elapsed = Date.now() - start;
    if (elapsed > maxMs) return 0;
    return 1.0 - (elapsed / maxMs);
  };
}

/**
 * Failure penalty: -1 when a failure condition is detected.
 * Useful for penalizing catastrophic actions (e.g., deleting wrong data).
 */
export function failurePenalty(
  isFailure: (obs: Observation) => boolean,
  penalty: number = -1.0,
): RewardFunction {
  return (obs: Observation) => isFailure(obs) ? penalty : 0;
}

/**
 * Episode length reward: reward inversely proportional to number of steps.
 * Only fires on the final step (when done=true). Encourages brevity.
 */
export function brevityReward(maxSteps: number): RewardFunction {
  return (_obs, _action, outcome, stepNumber) => {
    // Only fire when the task actually completes successfully
    if (outcome.isError) return 0;
    // Reward is higher when fewer steps are used
    return Math.max(0, 1.0 - (stepNumber / maxSteps));
  };
}
