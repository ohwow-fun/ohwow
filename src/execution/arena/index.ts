/**
 * Arena — Standardized Agent Training Environments
 *
 * Usage:
 *   import { LocalArena, toolSuccessReward, compositeReward } from './arena/index.js';
 *
 *   const arena = new LocalArena({
 *     config: { id: 'browser-nav', name: 'Browser Navigation', ... },
 *     toolCtx,
 *     experienceStream: brain.experienceStream,
 *     getProprioception: () => digitalBody.getProprioception(),
 *   });
 *
 *   const obs = await arena.reset();
 *   const result = await arena.step({ toolName: 'browser_navigate', input: { url: '...' } });
 */

export { LocalArena } from './arena.js';
export type {
  ArenaConfig,
  ArenaDomain,
  ArenaAction,
  Observation,
  ObservationMetadata,
  StepResult,
  StepInfo,
  EpisodeSummary,
  RewardFunction,
} from './types.js';
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
} from './reward.js';
export { TrajectoryRecorder } from './trajectory.js';
export type { Trajectory, TrajectoryStep } from './trajectory.js';

// Phase 3: Extended reward library
export {
  goalReward,
  deadlineReward,
  failurePenalty,
  brevityReward,
} from './rewards/sparse.js';
export {
  milestoneReward,
  diversityReward,
  antiRepetitionReward,
  informationGainReward,
  affordanceAlignmentReward,
  errorRecoveryReward,
} from './rewards/shaped.js';

// Phase 3: Difficulty scaling
export {
  scaleDifficulty,
  progressiveDifficulty,
  autoSelectDifficulty,
  DIFFICULTY_PRESETS,
  EASY,
  MEDIUM,
  HARD,
  EXPERT,
} from './difficulty.js';
export type { DifficultyLevel, DifficultyTier } from './difficulty.js';

// Phase 4: Arena generation
export { generateArenaFromDescription } from './arena-generator.js';

// Phase 6: Wire protocol + external interop
export { createArenaRouter } from './server.js';
export type { ArenaRegistry } from './server.js';
export { ExternalArenaClient } from './client.js';

// Phase 5: Training loop + skill transfer
export { runTrainingLoop } from './training-loop.js';
export type { TrainingConfig, TrainingResult, ActionPolicy } from './training-loop.js';
export { transferSkills, estimateTransferBenefit } from './transfer.js';
export type { TransferResult, TransferConfig } from './transfer.js';
