/**
 * Arena Training Loop — Episodic learning through practice
 *
 * Runs an agent through repeated episodes in an arena, extracting
 * learnings after each episode via the existing self-improvement pipeline.
 * Every N episodes, runs a full improvement cycle (memory compression,
 * pattern mining, skill synthesis, principle distillation).
 *
 * This is heuristic learning (not gradient-based RL): the agent improves
 * by accumulating memories, patterns, and skills from experience.
 */

import type { LocalArena } from './arena.js';
import type { ArenaAction, EpisodeSummary } from './types.js';
import type { ExperienceStream } from '../../brain/experience-stream.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../model-router.js';
import { runImprovementCycle } from '../../lib/self-improvement/improve.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface TrainingConfig {
  /** Number of episodes to run. */
  episodes: number;
  /** Run improvement cycle every N episodes. */
  improvementInterval: number;
  /** Agent ID to train. */
  agentId?: string;
  /** Workspace ID for DB scoping. */
  workspaceId: string;
  /** Policy for selecting actions (required). */
  actionPolicy: ActionPolicy;
  /** Stop early if average reward exceeds this threshold. */
  earlyStopReward?: number;
  /** Maximum total cost in cents before stopping. */
  budgetCents?: number;
}

/**
 * Action policy: given the current observation, select an action.
 * This is where the LLM or any decision-making logic lives.
 *
 * In production, this wraps the orchestrator's tool selection.
 * For testing, it can be a simple heuristic or random policy.
 */
export type ActionPolicy = (observation: {
  text?: string;
  affordances: Array<{ action: string }>;
  stepNumber: number;
}) => ArenaAction | Promise<ArenaAction>;

/** Result of a complete training run. */
export interface TrainingResult {
  /** Per-episode summaries. */
  episodes: EpisodeSummary[];
  /** Reward per episode. */
  episodeRewards: number[];
  /** Rolling average reward (window of 5). */
  rollingAvgReward: number[];
  /** Total episodes run. */
  totalEpisodes: number;
  /** Total improvement cycles run. */
  improvementCycles: number;
  /** Total wall-clock time in ms. */
  durationMs: number;
  /** Why training stopped. */
  stoppedReason: 'completed' | 'early_stop' | 'budget_exceeded';
}

// ============================================================================
// TRAINING LOOP
// ============================================================================

/**
 * Run the training loop: repeated episodes with periodic self-improvement.
 *
 * Loop:
 * 1. Reset arena
 * 2. Step until done (using actionPolicy for decisions)
 * 3. Record episode summary
 * 4. Every N episodes: run self-improvement cycle
 * 5. Check early stopping conditions
 */
export async function runTrainingLoop(
  config: TrainingConfig,
  arena: LocalArena,
  db: DatabaseAdapter,
  modelRouter: ModelRouter,
  experienceStream?: ExperienceStream,
): Promise<TrainingResult> {
  const startTime = Date.now();
  const episodeSummaries: EpisodeSummary[] = [];
  const episodeRewards: number[] = [];
  let improvementCycles = 0;
  let stoppedReason: TrainingResult['stoppedReason'] = 'completed';

  logger.info({
    arenaId: arena.getConfig().id,
    episodes: config.episodes,
    improvementInterval: config.improvementInterval,
  }, '[Training] Starting arena training loop');

  for (let ep = 0; ep < config.episodes; ep++) {
    // --- Run one episode ---
    let obs = await arena.reset();
    let done = false;

    while (!done) {
      const action = await config.actionPolicy({
        text: obs.text,
        affordances: obs.affordances,
        stepNumber: obs.metadata.stepNumber,
      });

      const result = await arena.step(action);
      obs = result.observation;
      done = result.done || result.truncated;
    }

    const summary = arena.getEpisodeSummary();
    if (summary) {
      episodeSummaries.push(summary);
      episodeRewards.push(summary.totalReward);
    }

    logger.debug({
      episode: ep + 1,
      reward: summary?.totalReward,
      steps: summary?.steps,
      success: summary?.success,
    }, '[Training] Episode complete');

    // --- Periodic improvement ---
    if ((ep + 1) % config.improvementInterval === 0) {
      logger.info({ episode: ep + 1 }, '[Training] Running self-improvement cycle');
      await runImprovementCycle(db, modelRouter, config.workspaceId, {
        agentId: config.agentId,
      });
      improvementCycles++;
    }

    // --- Early stopping: reward threshold ---
    if (config.earlyStopReward !== undefined && episodeRewards.length >= 5) {
      const recentAvg = average(episodeRewards.slice(-5));
      if (recentAvg >= config.earlyStopReward) {
        logger.info({ recentAvg, threshold: config.earlyStopReward }, '[Training] Early stop: reward threshold reached');
        stoppedReason = 'early_stop';
        break;
      }
    }

    // --- Budget check (approximate via episode count) ---
    if (config.budgetCents !== undefined) {
      // Simple heuristic: each episode costs roughly the same
      const estimatedCostPerEpisode = 0.5; // conservative estimate in cents
      const estimatedTotal = (ep + 1) * estimatedCostPerEpisode;
      if (estimatedTotal >= config.budgetCents) {
        logger.info({ estimatedTotal, budget: config.budgetCents }, '[Training] Budget limit reached');
        stoppedReason = 'budget_exceeded';
        break;
      }
    }
  }

  // Final improvement cycle
  if (episodeSummaries.length > 0 && episodeSummaries.length % config.improvementInterval !== 0) {
    await runImprovementCycle(db, modelRouter, config.workspaceId, {
      agentId: config.agentId,
    });
    improvementCycles++;
  }

  const result: TrainingResult = {
    episodes: episodeSummaries,
    episodeRewards,
    rollingAvgReward: computeRollingAvg(episodeRewards, 5),
    totalEpisodes: episodeSummaries.length,
    improvementCycles,
    durationMs: Date.now() - startTime,
    stoppedReason,
  };

  logger.info({
    totalEpisodes: result.totalEpisodes,
    avgReward: average(episodeRewards),
    improvementCycles,
    stoppedReason,
    durationMs: result.durationMs,
  }, '[Training] Training loop complete');

  return result;
}

// ============================================================================
// HELPERS
// ============================================================================

function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function computeRollingAvg(values: number[], window: number): number[] {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    return average(slice);
  });
}
