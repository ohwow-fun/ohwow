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
