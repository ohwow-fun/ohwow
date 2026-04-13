/**
 * Skill Synthesizer — pattern-miner → autolearner bridge (phase C).
 *
 * This module used to INSERT procedure-skill rows for every mined
 * tool-call pattern. That path was killed in the unified-skill refactor
 * (see /Users/jesus/.claude/plans/idempotent-tumbling-flame.md) because
 * procedure skills were discovered via keyword matchers that caused
 * the launch-eve regression.
 *
 * The pattern miner still runs on the 24h cron. Its output was being
 * discarded. Phase C reconnects it to the code-skill pipeline, closing
 * the unification loop the plan promised: one synthesis bus, two
 * sources (successes from the miner + failures from the detector),
 * one output (code skills in agent_workforce_skills).
 *
 * What this bridge does
 *
 *   - Takes a batch of MinedPattern objects from the miner.
 *   - Builds a PatternSynthesisCandidate for each one, keyed on a
 *     stable hash of the tool sequence so re-mining a pattern that
 *     already exists is idempotent at the candidate layer.
 *   - Emits a `synthesis:candidate` event on the bus the autolearner
 *     subscribes to. The actual skill-row insert happens downstream
 *     in `synthesis-auto-learner.ts#processCandidate` when it sees a
 *     candidate with `kind === 'pattern'`.
 *   - Returns the original SynthesisResult shape so the improvement
 *     cycle's metric aggregator (which logs skillsCreated) still gets
 *     sensible numbers. `skillsCreated` stays 0 here — the autolearner
 *     is the party that actually creates rows, and it writes its own
 *     counters via runtime-skill-metrics.
 *
 * Emission safety
 *
 *   - When no bus is supplied the function falls back to the pre-phase-C
 *     no-op behaviour (log + discard). Callers that haven't been
 *     updated to plumb a bus through still compile and run.
 *   - When `OHWOW_ENABLE_SYNTHESIS` is not set the bridge also stays
 *     dormant: emitting candidates nobody can process wastes log volume
 *     and risks surprising a daemon that opted out of the synthesis
 *     stack entirely.
 */

import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import type {
  PatternSynthesisCandidate,
} from '../../scheduling/synthesis-failure-detector.js';
import type { MinedPattern, SynthesisResult } from './types.js';
import { logger } from '../logger.js';

/**
 * Hash a tool sequence into a stable 12-char hex id. Used as the
 * `patternId` on the bus payload so re-emitting the same sequence is
 * cheap to deduplicate downstream without a DB round trip.
 */
export function hashToolSequence(toolSequence: string[]): string {
  return createHash('sha1')
    .update(toolSequence.join('\u0001'))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Convert a MinedPattern from the 24h improvement cycle into the bus
 * payload the autolearner expects. Pure, exported so the unit test
 * can assert the mapping without mocking the whole improvement run.
 */
export function buildPatternCandidate(
  pattern: MinedPattern,
  agentId: string,
): PatternSynthesisCandidate {
  return {
    kind: 'pattern',
    patternId: hashToolSequence(pattern.toolSequence),
    toolSequence: pattern.toolSequence,
    support: pattern.support,
    avgSuccessRate: pattern.avgSuccessRate,
    sourceTaskIds: pattern.sourceTaskIds,
    agentId,
    createdAt: new Date().toISOString(),
  };
}

export interface SynthesizeSkillsOptions {
  /**
   * Event bus shared with `synthesis-auto-learner.ts`. When present,
   * each mined pattern produces a `synthesis:candidate` event with
   * `kind: 'pattern'`. When absent, the bridge logs at debug level
   * and discards the patterns — same behaviour as the pre-phase-C
   * no-op.
   */
  bus?: EventEmitter;
}

/**
 * Bridge mined patterns into the synthesis candidate bus.
 *
 * Signature kept backwards-compatible with the pre-phase-C no-op:
 * callers that don't pass `options.bus` see the same zero-work
 * SynthesisResult they saw before. Callers that do pass a bus see
 * their patterns flow downstream.
 */
export async function synthesizeSkills(
  _db: DatabaseAdapter,
  _router: ModelRouter,
  _workspaceId: string,
  agentId: string,
  patterns: MinedPattern[],
  options: SynthesizeSkillsOptions = {},
): Promise<SynthesisResult> {
  const bus = options.bus;
  if (patterns.length === 0) {
    return {
      tracesAnalyzed: 0,
      patternsFound: 0,
      skillsCreated: 0,
      duplicatesSkipped: 0,
      tokensUsed: 0,
      costCents: 0,
    };
  }

  const synthesisEnabled = process.env.OHWOW_ENABLE_SYNTHESIS === '1';
  if (!bus || !synthesisEnabled) {
    logger.debug(
      {
        patternCount: patterns.length,
        reason: !bus ? 'no bus wired' : 'OHWOW_ENABLE_SYNTHESIS not set',
      },
      '[SkillSynthesizer] pattern bridge dormant, discarding patterns',
    );
    return {
      tracesAnalyzed: patterns[0]?.sourceTaskIds.length ?? 0,
      patternsFound: patterns.length,
      skillsCreated: 0,
      duplicatesSkipped: 0,
      tokensUsed: 0,
      costCents: 0,
    };
  }

  let emitted = 0;
  for (const pattern of patterns) {
    const candidate = buildPatternCandidate(pattern, agentId);
    bus.emit('synthesis:candidate', candidate);
    emitted++;
  }

  const tracesAnalyzed = patterns.reduce(
    (acc, p) => acc + p.sourceTaskIds.length,
    0,
  );
  logger.info(
    { agentId, patternCount: patterns.length, emitted },
    '[SkillSynthesizer] pattern candidates emitted to synthesis bus',
  );

  return {
    tracesAnalyzed,
    patternsFound: patterns.length,
    skillsCreated: 0,
    duplicatesSkipped: 0,
    tokensUsed: 0,
    costCents: 0,
  };
}
