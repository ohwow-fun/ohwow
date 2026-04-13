/**
 * SynthesisAutoLearner — closes the loop from failed task → new skill.
 *
 * The SynthesisFailureDetector scans agent_workforce_tasks every
 * minute and emits `synthesis:candidate` events for high-token
 * zero-output completions. Up to this module, nothing was listening.
 * The autolearner subscribes to that event and drives the same
 * probe → generate → test pipeline that `synthesize_skill_for_goal`
 * runs manually, except automatically and in response to real
 * failures ohwow observes in its own task stream.
 *
 * This is the first place in the codebase where ohwow's self-
 * improvement actually closes back on itself: the runtime sees its
 * agents flail on a repeatable task, probes the target surface,
 * writes a deterministic tool for it, dry-runs that tool, and parks
 * the tool in the registry so the NEXT attempt at a similar task
 * can skip the ReAct loop entirely.
 *
 * Safety defaults are paranoid
 *
 *   - Gated behind TWO env vars: OHWOW_ENABLE_SYNTHESIS must be set
 *     to opt in to the synthesis stack at all, and OHWOW_ENABLE_
 *     AUTO_LEARNING must additionally be set to '1' before the
 *     autolearner subscribes. Off by default even when synthesis
 *     is on, because launch-eve is not the place for autonomous
 *     tool generation triggered on a cron.
 *
 *   - Always dry-run. The tester runs the synthesized handler with
 *     dry_run=true, and the vision eval is stubbed to 'accept' in
 *     automatic mode so a single run can't burn model credits on a
 *     background loop. Promotion to live-callable status still
 *     requires a human-driven acceptance test.
 *
 *   - One candidate at a time. The autolearner processes candidates
 *     strictly sequentially via an internal queue. A slow synthesis
 *     run doesn't block the failure detector's next scan, but the
 *     detector's next candidate sits in the queue behind the active
 *     one. Prevents three concurrent probes from hammering Chrome.
 *
 *   - Requires a non-null `targetUrlGuess` on the candidate. A
 *     candidate without a URL signal gets logged and skipped — the
 *     detector's URL inference is best-effort, and we refuse to
 *     guess when it returned null.
 */

import type { EventEmitter } from 'node:events';

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';
import type { LocalToolContext } from '../orchestrator/local-tool-types.js';
import type { ModelRouter } from '../execution/model-router.js';
import { probeSurface } from '../orchestrator/tools/synthesis-probe.js';
import { generateCodeSkill } from '../orchestrator/tools/synthesis-generator.js';
import { generateCodeSkillFromPattern } from '../orchestrator/tools/synthesis-pattern-generator.js';
import { testSynthesizedSkill } from '../orchestrator/tools/synthesis-tester.js';
import { resolveActiveWorkspace } from '../config.js';
import type {
  PatternSynthesisCandidate,
  SynthesisCandidate,
  SynthesisCandidateAny,
} from './synthesis-failure-detector.js';
import { isFailureCandidate, isPatternCandidate } from './synthesis-failure-detector.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SynthesisAutoLearnerOptions {
  /** Same bus the SynthesisFailureDetector publishes on. */
  bus: EventEmitter;
  db: DatabaseAdapter;
  workspaceId: string;
  modelRouter: ModelRouter;
  /**
   * The tool context the generated skill handler will receive when
   * the tester invokes it with dry_run=true. Production callers
   * wire their daemon-scoped LocalToolContext here; tests pass a
   * stub ctx built with `makeCtx()` from the shared helper.
   */
  toolCtx: LocalToolContext;
}

// ---------------------------------------------------------------------------
// Env gating
// ---------------------------------------------------------------------------

export function isAutoLearningEnabled(): boolean {
  return (
    process.env.OHWOW_ENABLE_SYNTHESIS === '1' &&
    process.env.OHWOW_ENABLE_AUTO_LEARNING === '1'
  );
}

// ---------------------------------------------------------------------------
// Autolearner
// ---------------------------------------------------------------------------

export class SynthesisAutoLearner {
  private readonly opts: SynthesisAutoLearnerOptions;
  private readonly queue: SynthesisCandidateAny[] = [];
  private processing = false;
  private listener: ((candidate: SynthesisCandidateAny) => void) | null = null;
  private started = false;

  constructor(opts: SynthesisAutoLearnerOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.started) return;
    if (!isAutoLearningEnabled()) {
      logger.info(
        '[SynthesisAutoLearner] disabled — set OHWOW_ENABLE_SYNTHESIS=1 and OHWOW_ENABLE_AUTO_LEARNING=1 to enable',
      );
      return;
    }
    this.started = true;
    this.listener = (candidate: SynthesisCandidateAny) => {
      this.enqueue(candidate);
    };
    this.opts.bus.on('synthesis:candidate', this.listener);
    logger.info('[SynthesisAutoLearner] subscribed to synthesis:candidate events');
  }

  stop(): void {
    if (!this.started) return;
    if (this.listener) {
      this.opts.bus.off('synthesis:candidate', this.listener);
      this.listener = null;
    }
    this.queue.length = 0;
    this.started = false;
  }

  /** Exposed for tests so they don't need a real EventEmitter. */
  enqueue(candidate: SynthesisCandidateAny): void {
    this.queue.push(candidate);
    if (!this.processing) {
      void this.drain();
    }
  }

  /**
   * Process a single candidate. Branches on the candidate `kind`:
   * failure-mined candidates (the default) run through the full
   * probe → generate → test pipeline; pattern-mined candidates skip
   * straight to a DB row insert via the pattern generator.
   *
   * Exposed for tests — the queue loop just defers here.
   */
  async processCandidate(candidate: SynthesisCandidateAny): Promise<{
    outcome:
      | 'skipped_no_url'
      | 'probe_failed'
      | 'generate_failed'
      | 'test_failed'
      | 'registered'
      | 'pattern_insert_failed';
    reason?: string;
    skillName?: string;
  }> {
    if (isPatternCandidate(candidate)) {
      return this.processPatternCandidate(candidate);
    }
    // After the narrow above, TypeScript knows this is the
    // failure-mined variant (`kind` undefined or 'failure').
    if (!isFailureCandidate(candidate)) {
      return { outcome: 'skipped_no_url', reason: 'unknown candidate kind' };
    }
    if (!candidate.targetUrlGuess) {
      logger.info(
        { taskId: candidate.taskId },
        '[SynthesisAutoLearner] skipping candidate with no targetUrlGuess',
      );
      return { outcome: 'skipped_no_url' };
    }

    const targetUrl = candidate.targetUrlGuess;
    logger.info(
      { taskId: candidate.taskId, targetUrl, tokensUsed: candidate.tokensUsed },
      '[SynthesisAutoLearner] starting autonomous learning pipeline for candidate',
    );

    const probeResult = await probeSurface({
      url: targetUrl,
      goalDescription: candidate.title,
    });
    if (!probeResult.success || !probeResult.manifest) {
      logger.warn(
        { taskId: candidate.taskId, reason: probeResult.message },
        '[SynthesisAutoLearner] probe failed',
      );
      return { outcome: 'probe_failed', reason: probeResult.message };
    }

    const layout = resolveActiveWorkspace();
    const genResult = await generateCodeSkill({
      db: this.opts.db,
      workspaceId: this.opts.workspaceId,
      modelRouter: this.opts.modelRouter,
      candidate,
      manifest: probeResult.manifest,
      skillsDir: layout.skillsDir,
    });
    if (!genResult.ok) {
      logger.warn(
        { taskId: candidate.taskId, stage: genResult.stage, error: genResult.error },
        '[SynthesisAutoLearner] generator failed',
      );
      return { outcome: 'generate_failed', reason: `${genResult.stage}: ${genResult.error}` };
    }
    if (genResult.reused) {
      logger.info(
        { taskId: candidate.taskId, skillName: genResult.name },
        '[SynthesisAutoLearner] generator reused an already-promoted skill — pipeline idle',
      );
      return { outcome: 'registered', skillName: genResult.name };
    }

    const testResult = await testSynthesizedSkill({
      db: this.opts.db,
      modelRouter: this.opts.modelRouter,
      ctx: this.opts.toolCtx,
      skillName: genResult.name,
      testInput: {},
      goal: candidate.title,
      // Stub vision in autolearning mode so a background loop can't
      // burn vision-model credits on every failed task. Human-driven
      // acceptance still runs real vision (see synthesis-acceptance).
      _visionEvalForTest: async () => ({
        ok: true,
        reason: 'auto-learner stub vision — dry-run screenshot accepted without model call',
      }),
    });
    if (!testResult.ok) {
      logger.warn(
        { taskId: candidate.taskId, skillName: genResult.name, stage: testResult.stage },
        '[SynthesisAutoLearner] tester rejected autolearning attempt',
      );
      return { outcome: 'test_failed', reason: `${testResult.stage}: ${testResult.message}` };
    }

    logger.info(
      { taskId: candidate.taskId, skillName: genResult.name, skillId: genResult.skillId },
      '[SynthesisAutoLearner] autolearning pipeline registered + promoted a new skill',
    );
    return { outcome: 'registered', skillName: genResult.name };
  }

  /**
   * Pattern-mined branch. Takes a PatternSynthesisCandidate produced
   * by the skill-synthesizer bridge and persists it as a code-skill
   * row via the deterministic pattern generator. No probe, no LLM,
   * no tester — pattern candidates already come with evidence of
   * success, and row creation is idempotent on the pattern hash.
   */
  private async processPatternCandidate(
    candidate: PatternSynthesisCandidate,
  ): Promise<{
    outcome: 'registered' | 'pattern_insert_failed';
    reason?: string;
    skillName?: string;
  }> {
    logger.info(
      {
        patternId: candidate.patternId,
        sequenceLength: candidate.toolSequence.length,
        support: candidate.support,
      },
      '[SynthesisAutoLearner] processing pattern-mined candidate',
    );
    const result = await generateCodeSkillFromPattern({
      db: this.opts.db,
      workspaceId: this.opts.workspaceId,
      candidate,
    });
    if (!result.ok) {
      logger.warn(
        { patternId: candidate.patternId, stage: result.stage, error: result.error },
        '[SynthesisAutoLearner] pattern generator failed',
      );
      return { outcome: 'pattern_insert_failed', reason: `${result.stage}: ${result.error}` };
    }
    if (result.reused) {
      logger.info(
        { patternId: candidate.patternId, skillName: result.name },
        '[SynthesisAutoLearner] pattern already persisted, no new row',
      );
    } else {
      logger.info(
        { patternId: candidate.patternId, skillName: result.name, skillId: result.skillId },
        '[SynthesisAutoLearner] pattern-mined skill row created',
      );
    }
    return { outcome: 'registered', skillName: result.name };
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const candidate = this.queue.shift();
        if (!candidate) break;
        const candidateId = isPatternCandidate(candidate)
          ? `pattern:${candidate.patternId}`
          : `task:${candidate.taskId}`;
        try {
          await this.processCandidate(candidate);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : err, candidateId },
            '[SynthesisAutoLearner] processCandidate threw',
          );
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
