/**
 * Arena Reward Functions — Composable scoring for agent training
 *
 * Reward functions evaluate each step and return a scalar value.
 * They are composable: combine multiple signals via compositeReward().
 *
 * Two categories:
 * - Sparse rewards: fire only on specific events (goal completion, failure)
 * - Shaped rewards: provide per-step signal (tool success, efficiency)
 */

import type { Observation, ArenaAction, RewardFunction } from './types.js';
import type { ToolCallOutcome } from '../../orchestrator/tool-executor.js';

// ============================================================================
// SPARSE REWARDS — Task-level signals
// ============================================================================

/**
 * +1 when successCriteria returns true, 0 otherwise.
 * The classic sparse reward: no signal until the goal is reached.
 */
export function taskCompletionReward(
  successCriteria: (obs: Observation) => boolean,
): RewardFunction {
  return (obs: Observation) => successCriteria(obs) ? 1.0 : 0.0;
}

/**
 * +1 if the task completes within the time budget, scaled linearly.
 * Faster completion = higher reward.
 */
export function timedCompletionReward(
  maxMs: number,
  successCriteria: (obs: Observation) => boolean,
): RewardFunction {
  const startTime = Date.now();
  return (obs: Observation) => {
    if (!successCriteria(obs)) return 0.0;
    const elapsed = Date.now() - startTime;
    return Math.max(0, 1.0 - elapsed / maxMs);
  };
}

// ============================================================================
// SHAPED REWARDS — Per-step signals
// ============================================================================

/**
 * +1 for successful tool calls, -0.5 for errors.
 * Provides dense signal: every step gets feedback.
 */
export function toolSuccessReward(): RewardFunction {
  return (_obs: Observation, _action: ArenaAction, outcome: ToolCallOutcome) =>
    outcome.isError ? -0.5 : 1.0;
}

/**
 * Small penalty per step to encourage efficiency.
 * Without this, agents may loop indefinitely on successful-but-pointless actions.
 */
export function stepPenaltyReward(penalty: number = -0.01): RewardFunction {
  return () => penalty;
}

// ============================================================================
// COMPOSITION — Combine multiple reward signals
// ============================================================================

/**
 * Weighted combination of multiple reward functions.
 * The total reward is the sum of (weight * fn(obs, action, outcome, step)).
 */
export function compositeReward(
  components: Array<{ fn: RewardFunction; weight: number }>,
): RewardFunction {
  return (
    obs: Observation,
    action: ArenaAction,
    outcome: ToolCallOutcome,
    stepNumber: number,
  ) => {
    let total = 0;
    for (const { fn, weight } of components) {
      total += weight * fn(obs, action, outcome, stepNumber);
    }
    return total;
  };
}

/**
 * Clamp a reward function's output to [min, max].
 */
export function clampedReward(
  fn: RewardFunction,
  min: number,
  max: number,
): RewardFunction {
  return (obs, action, outcome, step) =>
    Math.max(min, Math.min(max, fn(obs, action, outcome, step)));
}
