/**
 * Shaped Reward Functions — Per-step signals
 *
 * Shaped rewards provide dense feedback at every step, making them
 * easier to learn from. They guide the agent toward the goal by
 * rewarding intermediate progress.
 *
 * These build on the body's Affordance system and ExperienceStream
 * to derive meaningful signals from existing infrastructure.
 */

import type { Observation, ArenaAction, RewardFunction } from '../types.js';
import type { ToolCallOutcome } from '../../../orchestrator/tool-executor.js';

/**
 * Milestone progress: reward for hitting checkpoints in order.
 * Each milestone is a predicate on the observation.
 * +1 for each new milestone reached. Does not re-fire.
 *
 * Example:
 *   progressReward([
 *     obs => obs.metadata.url?.includes('/login'),
 *     obs => obs.metadata.url?.includes('/dashboard'),
 *     obs => obs.text?.includes('Welcome'),
 *   ])
 */
export function milestoneReward(
  milestones: Array<(obs: Observation) => boolean>,
): RewardFunction {
  const reached = new Set<number>();
  return (obs: Observation) => {
    let reward = 0;
    for (let i = 0; i < milestones.length; i++) {
      if (!reached.has(i) && milestones[i](obs)) {
        reached.add(i);
        reward += 1.0 / milestones.length; // Normalized to sum to 1.0
      }
    }
    return reward;
  };
}

/**
 * Tool diversity reward: +bonus for each unique tool used.
 * Encourages exploration of the action space.
 */
export function diversityReward(bonus: number = 0.1): RewardFunction {
  const seen = new Set<string>();
  return (_obs: Observation, action: ArenaAction) => {
    if (seen.has(action.toolName)) return 0;
    seen.add(action.toolName);
    return bonus;
  };
}

/**
 * Anti-repetition reward: increasing penalty for consecutive same-tool calls.
 * First repeat: penalty * 1, second: penalty * 2, etc.
 * Resets when a different tool is used.
 */
export function antiRepetitionReward(penalty: number = -0.15): RewardFunction {
  let lastTool: string | null = null;
  let streak = 0;
  return (_obs: Observation, action: ArenaAction) => {
    if (action.toolName === lastTool) {
      streak++;
      return penalty * streak;
    }
    lastTool = action.toolName;
    streak = 0;
    return 0;
  };
}

/**
 * Information gain reward: reward for observations that contain new data.
 * Measures novelty by checking if the text output differs from previous steps.
 */
export function informationGainReward(bonus: number = 0.05): RewardFunction {
  const seenHashes = new Set<string>();
  return (obs: Observation) => {
    const text = obs.text ?? '';
    if (text.length < 10) return 0; // Too short to be informative
    // Simple hash: first 100 chars as fingerprint
    const hash = text.slice(0, 100);
    if (seenHashes.has(hash)) return 0;
    seenHashes.add(hash);
    return bonus;
  };
}

/**
 * Affordance utilization reward: reward for using high-readiness affordances.
 * Agents that use tools their body is ready for get a small bonus.
 */
export function affordanceAlignmentReward(bonus: number = 0.05): RewardFunction {
  return (obs: Observation, action: ArenaAction) => {
    const affordance = obs.affordances.find(a => a.action === action.toolName);
    if (!affordance) return -0.1; // Penalty for using non-afforded actions
    return bonus * affordance.readiness; // Higher readiness = higher reward
  };
}

/**
 * Error recovery reward: bonus when a successful step follows a failed one.
 * Encourages resilience and adaptive behavior.
 */
export function errorRecoveryReward(bonus: number = 0.3): RewardFunction {
  let lastWasError = false;
  return (_obs: Observation, _action: ArenaAction, outcome: ToolCallOutcome) => {
    const currentError = outcome.isError;
    const recovered = lastWasError && !currentError;
    lastWasError = currentError;
    return recovered ? bonus : 0;
  };
}

