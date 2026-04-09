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

/**
 * Reward for hitting milestones in order.
 * Each milestone is a predicate on the observation.
 * Fires +1 for each new milestone reached (doesn't re-fire).
 */
export function progressReward(
  milestones: Array<(obs: Observation) => boolean>,
): RewardFunction {
  const reached = new Set<number>();
  return (obs: Observation) => {
    let reward = 0;
    for (let i = 0; i < milestones.length; i++) {
      if (!reached.has(i) && milestones[i](obs)) {
        reached.add(i);
        reward += 1.0;
      }
    }
    return reward;
  };
}

/**
 * Reward for using different tools (encourages exploration).
 * +0.1 for each unique tool used for the first time.
 */
export function explorationReward(): RewardFunction {
  const usedTools = new Set<string>();
  return (_obs: Observation, action: ArenaAction) => {
    if (usedTools.has(action.toolName)) return 0;
    usedTools.add(action.toolName);
    return 0.1;
  };
}

/**
 * Penalty for using the same tool consecutively (discourages stagnation).
 * Mirrors the existing stagnation detection in the experience stream.
 */
export function antiStagnationReward(penalty: number = -0.2): RewardFunction {
  let lastTool: string | null = null;
  let repeatCount = 0;
  return (_obs: Observation, action: ArenaAction) => {
    if (action.toolName === lastTool) {
      repeatCount++;
      // Increasing penalty for consecutive repeats
      return penalty * repeatCount;
    }
    lastTool = action.toolName;
    repeatCount = 0;
    return 0;
  };
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
