/**
 * Skill Synthesizer — DEPRECATED no-op
 *
 * This module used to take pattern-mined tool-call sequences,
 * call an LLM to generate skill metadata, and INSERT new rows with
 * `skill_type='procedure'` into agent_workforce_skills. That path
 * has been deprecated — see
 * /Users/jesus/.claude/plans/idempotent-tumbling-flame.md.
 *
 * Reason: procedure skills are discovered at runtime via three
 * keyword matchers that collectively caused the launch-eve
 * regression (a prompt to rewrite local `.md` files matched the
 * word "write" and routed a sub-agent into an X-compose loop
 * against an unauth'd Chrome). The matchers have been removed.
 * Without them procedure rows have no runtime discovery path, so
 * creating new ones is pointless.
 *
 * The pattern miner still runs on the 24h cron. Its output is
 * discarded by this no-op. Post-launch phase C will bridge the
 * miner to the synthesis autolearner's `synthesis:candidate` event
 * bus so mined patterns flow into the code-skill pipeline and
 * become `.ts` files the runtime registry picks up. Until then,
 * pattern data is cheap to keep producing but unused.
 *
 * This file retains its public export `synthesizeSkills` with the
 * same signature so its single caller (`runImprovementCycle` in
 * improve.ts) doesn't need edits.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import type { MinedPattern, SynthesisResult } from './types.js';
import { logger } from '../logger.js';

/**
 * Deprecated — returns a zero-work SynthesisResult so the improvement
 * cycle's metric aggregator sees "0 skills created" without erroring
 * out. Phase C (post-launch) will replace this with a bridge that
 * emits synthesis:candidate events from each MinedPattern so the
 * code-skill autolearner can generate a real handler.
 */
export async function synthesizeSkills(
  _db: DatabaseAdapter,
  _router: ModelRouter,
  _workspaceId: string,
  _agentId: string,
  patterns: MinedPattern[],
): Promise<SynthesisResult> {
  if (patterns.length > 0) {
    logger.debug(
      { patternCount: patterns.length },
      '[SkillSynthesizer] deprecated path — patterns discarded, bridge to autolearner pending (phase C)',
    );
  }
  return {
    tracesAnalyzed: patterns.length > 0 ? patterns[0].sourceTaskIds.length : 0,
    patternsFound: patterns.length,
    skillsCreated: 0,
    duplicatesSkipped: 0,
    tokensUsed: 0,
    costCents: 0,
  };
}
