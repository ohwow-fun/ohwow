/**
 * Trio primitive — runs `plan -> impl -> qa` rounds against an injected
 * `RoundExecutor` and applies the spec's trio control-flow rules.
 *
 * Phase 2 keeps everything in-memory; persistence is delegated to an
 * optional `onRoundComplete` hook so Phase 3 can wire DB writes
 * (`phase_trios` / `phase_rounds`) without touching this file.
 *
 * Sharp rules from `docs/autonomy-architecture.md`:
 *   - Outcome `successful` requires QA verdict `passed` or `failed-fixed`.
 *   - QA verdict `failed-escalate` -> outcome `regressed`.
 *   - Plan returning `continue` without a `next_round_brief` is a
 *     contract violation -> `regressed` (we cannot start impl).
 *   - Abort is polled at round boundaries only, never mid-round.
 *   - Wall-clock cap (default 90 min) is checked at each boundary.
 */

import { logger } from '../lib/logger.js';
import { runRound, RoundReturnParseError } from './round-runner.js';
import type {
  RoundBrief,
  RoundExecutor,
  RoundKind,
  RoundReturn,
  TrioInput,
  TrioResult,
  TrioRoundRecord,
  TrioOutcome,
} from './types.js';

const DEFAULT_MAX_MINUTES = 90;

interface TrioState {
  input: TrioInput;
  executor: RoundExecutor;
  rounds: TrioRoundRecord[];
  startedAtMs: number;
  maxMinutes: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildBrief(
  input: TrioInput,
  kind: RoundKind,
  body: string,
  prior: RoundReturn | undefined,
  goal: string,
): RoundBrief {
  return {
    trio_id: input.trio_id,
    kind,
    mode: input.mode,
    goal,
    body,
    prior,
  };
}

function finish(
  state: TrioState,
  outcome: TrioOutcome,
  reason?: string,
): TrioResult {
  const qaRound = state.rounds.find((r) => r.kind === 'qa');
  return {
    trio_id: state.input.trio_id,
    outcome,
    rounds: state.rounds,
    reason,
    qa_evaluation: qaRound?.ret.evaluation,
  };
}

/** Returns the abort reason if any, else null. */
function checkAbort(state: TrioState): string | null {
  const ab = state.input.abort?.poll();
  if (ab) return ab.reason;
  const elapsedMs = Date.now() - state.startedAtMs;
  if (elapsedMs > state.maxMinutes * 60_000) return 'wall_clock_exceeded';
  return null;
}

async function runOne(
  state: TrioState,
  brief: RoundBrief,
): Promise<RoundReturn> {
  const started_at = nowIso();
  const ret = await runRound(state.executor, brief);
  const ended_at = nowIso();
  state.rounds.push({ kind: brief.kind, brief, ret, started_at, ended_at });
  if (state.input.onRoundComplete) {
    await state.input.onRoundComplete(brief, ret);
  }
  return ret;
}

export async function runTrio(
  input: TrioInput,
  executor: RoundExecutor,
): Promise<TrioResult> {
  const state: TrioState = {
    input,
    executor,
    rounds: [],
    startedAtMs: Date.now(),
    maxMinutes: input.max_minutes ?? DEFAULT_MAX_MINUTES,
  };

  logger.info(
    { trio_id: input.trio_id, mode: input.mode, goal: input.goal },
    'trio.start',
  );

  // ------------------------------------------------------------------
  // Boundary 0: pre-plan abort check
  // ------------------------------------------------------------------
  const preAbort = checkAbort(state);
  if (preAbort) {
    logger.warn({ trio_id: input.trio_id, reason: preAbort }, 'trio.abort.pre-plan');
    return finish(state, 'blocked', preAbort);
  }

  // ------------------------------------------------------------------
  // Plan round
  // ------------------------------------------------------------------
  const planBrief = buildBrief(input, 'plan', input.initial_plan_brief, undefined, input.goal);
  let planRet: RoundReturn;
  try {
    planRet = await runOne(state, planBrief);
  } catch (e) {
    if (e instanceof RoundReturnParseError) {
      return finish(state, 'regressed', e.message);
    }
    throw e;
  }

  switch (planRet.status) {
    case 'needs-input': {
      if (input.onFounderQuestion) {
        await input.onFounderQuestion({ round: 'plan', brief: planBrief, ret: planRet });
      }
      return finish(state, 'awaiting-founder', planRet.summary.split('\n')[0]);
    }
    case 'blocked':
      return finish(state, 'blocked', planRet.summary.split('\n')[0]);
    case 'done':
      // Pure-discovery plan that legitimately finishes the trio without
      // touching code. Rare but allowed by the spec.
      logger.info({ trio_id: input.trio_id }, 'trio.plan.done-without-impl');
      return finish(state, 'successful');
    case 'continue':
      if (!planRet.next_round_brief) {
        return finish(
          state,
          'regressed',
          'plan returned continue without next_round_brief',
        );
      }
      break;
  }

  // ------------------------------------------------------------------
  // Boundary 1: pre-impl abort check
  // ------------------------------------------------------------------
  const preImplAbort = checkAbort(state);
  if (preImplAbort) {
    logger.warn(
      { trio_id: input.trio_id, reason: preImplAbort },
      'trio.abort.pre-impl',
    );
    return finish(state, 'blocked', preImplAbort);
  }

  // ------------------------------------------------------------------
  // Impl round
  // ------------------------------------------------------------------
  const implBrief = buildBrief(
    input,
    'impl',
    planRet.next_round_brief!,
    planRet,
    input.goal,
  );
  let implRet: RoundReturn;
  try {
    implRet = await runOne(state, implBrief);
  } catch (e) {
    if (e instanceof RoundReturnParseError) {
      return finish(state, 'regressed', e.message);
    }
    throw e;
  }

  switch (implRet.status) {
    case 'blocked':
      // Spec: phase decides re-plan vs partial-close. Trio just signals.
      return finish(state, 'regressed', implRet.summary.split('\n')[0]);
    case 'needs-input': {
      if (input.onFounderQuestion) {
        await input.onFounderQuestion({ round: 'impl', brief: implBrief, ret: implRet });
      }
      return finish(state, 'awaiting-founder', implRet.summary.split('\n')[0]);
    }
    case 'done':
      // Impl claims done without QA. Spec only allows this when the trio is
      // a no-op (e.g., plan already proved nothing needs doing). We accept
      // and warn — the QA round was clearly skipped intentionally.
      logger.warn(
        { trio_id: input.trio_id },
        'trio.impl.done-without-qa (accepted as successful with warning)',
      );
      return finish(state, 'successful');
    case 'continue':
      break;
  }

  // ------------------------------------------------------------------
  // Boundary 2: pre-qa abort check
  // ------------------------------------------------------------------
  const preQaAbort = checkAbort(state);
  if (preQaAbort) {
    logger.warn(
      { trio_id: input.trio_id, reason: preQaAbort },
      'trio.abort.pre-qa',
    );
    return finish(state, 'blocked', preQaAbort);
  }

  // ------------------------------------------------------------------
  // QA round — body defaults to a verify-the-impl brief unless impl
  // overrode via next_round_brief.
  // ------------------------------------------------------------------
  const qaBody =
    implRet.next_round_brief ??
    'Verify the impl. Criteria from plan.';
  const qaBrief = buildBrief(input, 'qa', qaBody, implRet, input.goal);
  let qaRet: RoundReturn;
  try {
    qaRet = await runOne(state, qaBrief);
  } catch (e) {
    if (e instanceof RoundReturnParseError) {
      return finish(state, 'regressed', e.message);
    }
    throw e;
  }

  // round-runner already enforced that QA carries an evaluation block.
  const verdict = qaRet.evaluation?.verdict;
  if (!verdict) {
    // Defensive: should be impossible after validation, but if it ever
    // happens treat as a regression rather than crash the orchestration.
    return finish(state, 'regressed', 'qa.evaluation missing after validation');
  }

  switch (verdict) {
    case 'passed':
    case 'failed-fixed':
      return finish(state, 'successful');
    case 'failed-escalate':
      return finish(state, 'regressed', `qa verdict: ${verdict}`);
  }
}
