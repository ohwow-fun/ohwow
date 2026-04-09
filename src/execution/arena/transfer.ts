/**
 * Arena Skill Transfer — Cross-arena knowledge reuse
 *
 * Extracts reusable patterns and skills from trajectories in one arena
 * and makes them available when training in a different arena.
 *
 * Uses the existing pattern miner to find tool sequences, then the
 * skill synthesizer to create reusable skill prompts. Skills are
 * stored per-workspace (not per-arena), so they naturally transfer.
 *
 * Inspired by Gym-V's finding that diverse training generalizes
 * broadly while narrow training causes negative transfer.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../model-router.js';
import type { Trajectory } from './trajectory.js';
import { mineToolPatterns } from '../../lib/self-improvement/pattern-miner.js';
import { synthesizeSkills } from '../../lib/self-improvement/skill-synthesizer.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface TransferResult {
  /** Source arena ID. */
  sourceArenaId: string;
  /** Target arena ID (what we're transferring to). */
  targetArenaId: string;
  /** Number of tool patterns found in source trajectories. */
  patternsFound: number;
  /** Number of skills synthesized and stored. */
  skillsCreated: number;
  /** Skills that already existed (dedup). */
  duplicatesSkipped: number;
  /** Estimated benefit: ratio of source tools that also exist in target. */
  toolOverlap: number;
  /** Cost of synthesis in cents. */
  costCents: number;
}

export interface TransferConfig {
  /** Workspace scope. */
  workspaceId: string;
  /** Agent ID whose skills we're building. */
  agentId: string;
  /** Source arena ID. */
  sourceArenaId: string;
  /** Target arena ID. */
  targetArenaId: string;
  /** Target arena's allowed tools (for overlap calculation). */
  targetAllowedTools?: string[];
}

// ============================================================================
// TRANSFER
// ============================================================================

/**
 * Transfer skills from source arena trajectories to a target arena.
 *
 * Process:
 * 1. Mine tool patterns from the agent's completed tasks (source arena)
 * 2. Synthesize reusable skills from patterns
 * 3. Calculate tool overlap with target arena
 * 4. Skills are stored at workspace level, so they're automatically
 *    available in the target arena
 */
export async function transferSkills(
  config: TransferConfig,
  db: DatabaseAdapter,
  modelRouter: ModelRouter,
  sourceTrajectories?: Trajectory[],
): Promise<TransferResult> {
  const { workspaceId, agentId, sourceArenaId, targetArenaId, targetAllowedTools } = config;

  logger.info({
    sourceArenaId,
    targetArenaId,
    trajectoryCount: sourceTrajectories?.length,
  }, '[Transfer] Starting cross-arena skill transfer');

  // Step 1: Mine patterns from agent's task history
  // (pattern miner uses completed tasks from DB, which includes arena episodes)
  const patterns = await mineToolPatterns(db, workspaceId, agentId);

  if (patterns.length === 0) {
    logger.info('[Transfer] No patterns found in source arena');
    return {
      sourceArenaId,
      targetArenaId,
      patternsFound: 0,
      skillsCreated: 0,
      duplicatesSkipped: 0,
      toolOverlap: 0,
      costCents: 0,
    };
  }

  // Step 2: Synthesize skills from patterns
  const synthesis = await synthesizeSkills(db, modelRouter, workspaceId, agentId, patterns);

  // Step 3: Calculate tool overlap
  let toolOverlap = 1.0; // Default: assume full overlap
  if (targetAllowedTools && targetAllowedTools.length > 0) {
    const sourceTools = new Set<string>();
    for (const pattern of patterns) {
      for (const tool of pattern.toolSequence) {
        sourceTools.add(tool);
      }
    }
    const targetSet = new Set(targetAllowedTools);
    const overlap = [...sourceTools].filter(t => targetSet.has(t)).length;
    toolOverlap = sourceTools.size > 0 ? overlap / sourceTools.size : 0;
  }

  const result: TransferResult = {
    sourceArenaId,
    targetArenaId,
    patternsFound: patterns.length,
    skillsCreated: synthesis.skillsCreated,
    duplicatesSkipped: synthesis.duplicatesSkipped,
    toolOverlap,
    costCents: synthesis.costCents,
  };

  logger.info({
    patternsFound: result.patternsFound,
    skillsCreated: result.skillsCreated,
    toolOverlap: result.toolOverlap,
  }, '[Transfer] Skill transfer complete');

  return result;
}

/**
 * Estimate transfer benefit before running the full pipeline.
 * Returns the tool overlap ratio between source and target arenas.
 * Higher overlap = more likely that skills will transfer well.
 */
export function estimateTransferBenefit(
  sourceTools: string[],
  targetTools: string[],
): number {
  if (sourceTools.length === 0 || targetTools.length === 0) return 0;
  const targetSet = new Set(targetTools);
  const overlap = sourceTools.filter(t => targetSet.has(t)).length;
  return overlap / sourceTools.length;
}
