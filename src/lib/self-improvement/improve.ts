/**
 * Self-Improvement Orchestrator — `ohwow improve`
 *
 * Runs a simplified self-improvement cycle locally:
 * 1. Compress memories (if LLM available)
 * 2. Mine skill patterns
 * 3. Synthesize skills (if LLM available)
 * 4. Mine processes
 * 5. Suggest workflows (if LLM available)
 * 6. Distill principles (if LLM available)
 * 7. Evaluate proactive signals
 * 8. Build digital twin snapshot
 *
 * BYOK users get the full cycle. Ollama-only users get
 * degraded quality for LLM-dependent steps.
 */

import type { EventEmitter } from 'node:events';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import type { ImprovementCycleResult } from './types.js';
import { compressEpisodicMemories } from './memory-compression.js';
import { mineToolPatterns } from './pattern-miner.js';
import { synthesizeSkills } from './skill-synthesizer.js';
import { mineWorkflowPatterns } from './sequence-miner.js';
import { suggestWorkflows } from './workflow-suggester.js';
import { distillPrinciples } from './principle-distiller.js';
import { evaluateSignals } from './signal-evaluator.js';
import { buildDigitalTwin } from './digital-twin.js';
import { logger } from '../logger.js';

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

/**
 * Run a self-improvement cycle for a workspace.
 *
 * @param db - Database adapter
 * @param router - Model router for LLM calls
 * @param workspaceId - Workspace scope
 * @param options - Optional overrides
 */
export async function runImprovementCycle(
  db: DatabaseAdapter,
  router: ModelRouter,
  workspaceId: string,
  options?: {
    /** Only run for a specific agent */
    agentId?: string;
    /** Skip LLM-dependent steps (compression, synthesis, etc.) */
    skipLLM?: boolean;
    /**
     * Event bus shared with the synthesis autolearner. When provided,
     * mined tool-call patterns are emitted as `synthesis:candidate`
     * events with `kind: 'pattern'` so the autolearner can freeze
     * them into code-skill rows. Phase C of the unified-skill plan.
     */
    synthesisBus?: EventEmitter;
  }
): Promise<ImprovementCycleResult> {
  const startTime = Date.now();
  const skipLLM = options?.skipLLM ?? false;

  const result: ImprovementCycleResult = {
    compression: null,
    patternMining: null,
    skillSynthesis: null,
    processMining: null,
    principleDistillation: null,
    signalEvaluation: null,
    digitalTwin: null,
    totalTokensUsed: 0,
    totalCostCents: 0,
    durationMs: 0,
  };

  logger.info({ workspaceId, skipLLM }, '[Improve] Starting self-improvement cycle');

  // Get agents to process
  const agentIds = await getAgentIds(db, workspaceId, options?.agentId);
  if (agentIds.length === 0) {
    logger.info('[Improve] No agents found, skipping cycle');
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // Phase 1: Memory Compression (LLM-dependent)
  if (!skipLLM) {
    for (const agentId of agentIds) {
      try {
        const compression = await compressEpisodicMemories(db, router, workspaceId, agentId);
        if (!result.compression) {
          result.compression = compression;
        } else {
          result.compression.episodicAnalyzed += compression.episodicAnalyzed;
          result.compression.compressedCreated += compression.compressedCreated;
          result.compression.episodicSuperseded += compression.episodicSuperseded;
          result.compression.tokensUsed += compression.tokensUsed;
          result.compression.costCents += compression.costCents;
        }
        result.totalTokensUsed += compression.tokensUsed;
        result.totalCostCents += compression.costCents;
      } catch (err) {
        logger.error({ err, agentId }, '[Improve] Compression failed for agent');
      }
    }
  }

  // Phase 2: Pattern Mining (no LLM)
  const allPatterns: Record<string, Awaited<ReturnType<typeof mineToolPatterns>>> = {};
  for (const agentId of agentIds) {
    try {
      const patterns = await mineToolPatterns(db, workspaceId, agentId);
      if (patterns.length > 0) {
        allPatterns[agentId] = patterns;
      }
      if (!result.patternMining) {
        result.patternMining = { patternsFound: patterns.length };
      } else {
        result.patternMining.patternsFound += patterns.length;
      }
    } catch (err) {
      logger.error({ err, agentId }, '[Improve] Pattern mining failed for agent');
    }
  }

  // Phase 3: Skill Synthesis (LLM-dependent)
  if (!skipLLM) {
    for (const [agentId, patterns] of Object.entries(allPatterns)) {
      try {
        const synthesis = await synthesizeSkills(db, router, workspaceId, agentId, patterns, {
          bus: options?.synthesisBus,
        });
        if (!result.skillSynthesis) {
          result.skillSynthesis = synthesis;
        } else {
          result.skillSynthesis.skillsCreated += synthesis.skillsCreated;
          result.skillSynthesis.duplicatesSkipped += synthesis.duplicatesSkipped;
          result.skillSynthesis.tokensUsed += synthesis.tokensUsed;
          result.skillSynthesis.costCents += synthesis.costCents;
        }
        result.totalTokensUsed += synthesis.tokensUsed;
        result.totalCostCents += synthesis.costCents;
      } catch (err) {
        logger.error({ err, agentId }, '[Improve] Skill synthesis failed for agent');
      }
    }
  }

  // Phase 4: Process Mining (no LLM for mining, LLM for suggestions)
  try {
    const candidates = await mineWorkflowPatterns(db, workspaceId);
    result.processMining = {
      entriesAnalyzed: 0,
      candidatesFound: candidates.length,
      processesDiscovered: 0,
      duplicatesSkipped: 0,
      tokensUsed: 0,
      costCents: 0,
    };

    if (!skipLLM && candidates.length > 0) {
      const miningResult = await suggestWorkflows(db, router, workspaceId, candidates);
      result.processMining = miningResult;
      result.totalTokensUsed += miningResult.tokensUsed;
      result.totalCostCents += miningResult.costCents;
    }
  } catch (err) {
    logger.error({ err }, '[Improve] Process mining failed');
  }

  // Phase 5: Principle Distillation (LLM-dependent)
  if (!skipLLM) {
    for (const agentId of agentIds) {
      try {
        const distillation = await distillPrinciples(db, router, workspaceId, agentId);
        if (!result.principleDistillation) {
          result.principleDistillation = distillation;
        } else {
          result.principleDistillation.principlesCreated += distillation.principlesCreated;
          result.principleDistillation.duplicatesSkipped += distillation.duplicatesSkipped;
          result.principleDistillation.tokensUsed += distillation.tokensUsed;
          result.principleDistillation.costCents += distillation.costCents;
        }
        result.totalTokensUsed += distillation.tokensUsed;
        result.totalCostCents += distillation.costCents;
      } catch (err) {
        logger.error({ err, agentId }, '[Improve] Principle distillation failed for agent');
      }
    }
  }

  // Phase 6: Signal Evaluation (no LLM)
  try {
    const signals = await evaluateSignals(db, workspaceId);
    result.signalEvaluation = { signalsFound: signals.length };
  } catch (err) {
    logger.error({ err }, '[Improve] Signal evaluation failed');
  }

  // Phase 7: Digital Twin (no LLM)
  try {
    const { result: twinResult } = await buildDigitalTwin(db, workspaceId);
    result.digitalTwin = twinResult;
  } catch (err) {
    logger.error({ err }, '[Improve] Digital twin build failed');
  }

  result.durationMs = Date.now() - startTime;

  logger.info(
    {
      workspaceId,
      durationMs: result.durationMs,
      totalTokensUsed: result.totalTokensUsed,
      totalCostCents: result.totalCostCents,
      compression: result.compression ? `${result.compression.compressedCreated} created` : 'skipped',
      patterns: result.patternMining?.patternsFound ?? 0,
      skills: result.skillSynthesis?.skillsCreated ?? 0,
      processes: result.processMining?.processesDiscovered ?? 0,
      principles: result.principleDistillation?.principlesCreated ?? 0,
      signals: result.signalEvaluation?.signalsFound ?? 0,
      twin: result.digitalTwin ? `${result.digitalTwin.edgesCount} edges` : 'skipped',
    },
    '[Improve] Self-improvement cycle completed',
  );

  return result;
}

// ============================================================================
// HELPERS
// ============================================================================

async function getAgentIds(db: DatabaseAdapter, workspaceId: string, specificAgentId?: string): Promise<string[]> {
  if (specificAgentId) return [specificAgentId];

  try {
    const { data: agents } = await db
      .from('agent_workforce_agents')
      .select('id')
      .eq('workspace_id', workspaceId);

    return (agents ?? []).map((a) => (a as Record<string, unknown>).id as string);
  } catch {
    return [];
  }
}
