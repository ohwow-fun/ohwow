/**
 * Arena Reward Library — All reward functions
 *
 * Re-exports from core reward.ts plus specialized sparse and shaped rewards.
 */

// Core rewards (Phase 1)
export {
  taskCompletionReward,
  timedCompletionReward,
  toolSuccessReward,
  stepPenaltyReward,
  progressReward,
  explorationReward,
  antiStagnationReward,
  compositeReward,
  clampedReward,
} from '../reward.js';

// Sparse rewards (Phase 3)
export {
  goalReward,
  deadlineReward,
  failurePenalty,
  brevityReward,
} from './sparse.js';

// Shaped rewards (Phase 3)
export {
  milestoneReward,
  diversityReward,
  antiRepetitionReward,
  informationGainReward,
  affordanceAlignmentReward,
  errorRecoveryReward,
} from './shaped.js';
