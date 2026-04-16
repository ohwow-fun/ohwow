/**
 * DeliverableActionSentinelExperiment — scans recent tasks that declared
 * a `deferred_action` (post_tweet, send_email, etc.) and checks their
 * final output for canary phrases indicating the agent ran into an
 * authentication, permission, or execution wall and gave up without
 * actually performing the action.
 *
 * Why this exists
 * ---------------
 * 2026-04-16 we found an "unauthed chromium tried to post to X" loop
 * where a synthesized skill (`post_tweet_synth_*.ts`) bypassed profile
 * pinning, landed on X's login dialog, and the agent verbatim wrote
 * "I don't have access to the @ohwow_fun account credentials" — then
 * task-completion.ts happily marked the row `status=completed`. Every
 * observability surface downstream (content-cadence goal counters,
 * trust-output executor, deliverable ledger, revenue-pipeline observer)
 * treats `completed` as success, so the failure was invisible to every
 * other experiment. The Browser Profile Guardian was specifically built
 * for mismatches but the broken skill uses raw CDP and writes nothing
 * to the profile-events ledger, so Guardian passed vacuously.
 *
 * This sentinel plugs the gap by reading the one signal the agent
 * DOES produce reliably: plain-English narration of the failure in the
 * task's `output` column. It doesn't try to be clever — a deliberate
 * canary list of auth/permission giveaway phrases is enough to catch
 * the class. When a tasks' output carries any canary AND the task
 * declared a deferred_action, the task is flagged as a "narrated
 * failure" even though status=completed.
 *
 * Verdict
 * -------
 *   pass    — fewer than MIN_SAMPLES flagged tasks in window
 *   warning — 1+ flagged tasks (operator should know)
 *   fail    — flagged_rate ≥ FAIL_RATE AND at least MIN_SAMPLES
 *             flagged tasks — the pipeline is actively broken
 *
 * Tracked field: `narrated_failure_rate_6h`, so the Piece 1 distiller
 * can z-score sudden spikes vs the rolling baseline. A single failure
 * after a long clean streak flips novelty.reason → `verdict_flipped`,
 * which propagates into the daily surprise digest.
 *
 * Non-goals
 * ---------
 *   - Not an intervener: doesn't retry the action or mutate tasks.
 *     The operator (or a downstream experiment) owns remediation.
 *     This module's job is to make the failure visible.
 *   - Not a regex judge for the output itself — canary phrases are
 *     lowercase substring matches so translations, casing, and minor
 *     wording drift don't hide failures.
 *   - Not coupled to post_tweet — any declared deferred_action type
 *     is eligible, so a future `send_email` skill that hits a 2FA
 *     gate and gives up is caught by the same mechanism.
 */

import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { logger } from '../../lib/logger.js';

const PROBE_EVERY_MS = 5 * 60 * 1000;
const LOOKBACK_HOURS = 6;
/** Minimum flagged tasks in window required to move beyond `pass`. */
const MIN_SAMPLES = 1;
/** Minimum flagged tasks required for the fail verdict. A single
 *  narrated failure is noisy (one flaky network call, one truncated
 *  agent output) — promote to fail only when the pattern is
 *  reproducible within the window. */
const MIN_FAIL_SAMPLES = 2;
/** Flagged fraction above which we promote warning → fail. */
const FAIL_RATE = 0.5;

/**
 * Lowercase substrings we treat as prima-facie evidence the agent gave
 * up on an action. Deliberately skewed toward auth/permission gates
 * (the bug class that drove this experiment) but kept broad enough to
 * catch other execution walls. False positives here are acceptable —
 * a flagged task always deserves a human read. False negatives (we
 * miss a real giveaway) are the expensive ones, so when in doubt
 * extend this list.
 *
 * Keep phrases short and non-specific so translations and minor
 * paraphrases still hit. Exported so operators can extend it via a
 * future runtime_settings override without recompiling.
 */
export const NARRATED_FAILURE_CANARIES: readonly string[] = [
  'login page',
  'login dialog',
  'sign-in page',
  'sign in page',
  'cannot log in',
  "can't log in",
  'cannot sign in',
  "can't sign in",
  'not signed in',
  'not logged in',
  'redirected to login',
  "don't have access",
  'do not have access',
  "don't have credentials",
  'do not have credentials',
  'cannot automate',
  "can't automate",
  'cannot authenticate',
  'permission denied',
  'access denied',
  'refused to post',
  'refused to send',
  'could not post',
  'could not send',
] as const;

interface CandidateTask {
  id: string;
  title: string | null;
  status: string;
  output: string | null;
  deferred_action: string | null;
  completed_at: string | null;
}

interface FlaggedTask {
  task_id: string;
  title: string;
  action_type: string;
  canary: string;
  output_preview: string;
}

export interface DeliverableActionSentinelEvidence extends Record<string, unknown> {
  tasks_in_window: number;
  flagged_tasks: number;
  narrated_failure_rate_6h: number;
  /** Top 5 flagged tasks with ids + canary hits, newest first. */
  flagged: FlaggedTask[];
  /** Count of flagged tasks grouped by deferred_action.type. */
  by_action_type: Record<string, number>;
  __tracked_field: 'narrated_failure_rate_6h';
}

interface DeferredActionShape {
  type?: unknown;
  provider?: unknown;
}

function parseDeferred(raw: string | null): DeferredActionShape | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as DeferredActionShape) : null;
  } catch {
    return null;
  }
}

/** Returns the first canary phrase whose substring appears in the output, or null. */
function matchCanary(output: string | null): string | null {
  if (!output) return null;
  const lower = output.toLowerCase();
  for (const phrase of NARRATED_FAILURE_CANARIES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

export class DeliverableActionSentinelExperiment implements Experiment {
  readonly id = 'deliverable-action-sentinel';
  readonly name = 'Deliverable action sentinel';
  readonly category: ExperimentCategory = 'tool_reliability';
  readonly hypothesis =
    'Tasks that declared a deferred_action (post_tweet, send_email, etc.) and completed without the agent narrating an authentication / permission / execution wall are actually successful. A match on any canary phrase means the system routed status=completed on a task that, by the agent\'s own words, did not perform the action.';
  readonly cadence = { everyMs: PROBE_EVERY_MS, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    let rows: CandidateTask[] = [];
    try {
      const result = await ctx.db
        .from('agent_workforce_tasks')
        .select('id, title, status, output, deferred_action, completed_at')
        .eq('workspace_id', ctx.workspaceId)
        .gte('completed_at', sinceIso)
        .not('deferred_action', 'is', null)
        .order('completed_at', { ascending: false })
        .limit(500);
      rows = ((result.data ?? []) as unknown as CandidateTask[]).filter((r) => r && r.deferred_action);
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : err },
        '[deliverable-action-sentinel] query failed',
      );
      // Return a pass result rather than propagating — sentinels must
      // never take down the runner.
      const evidence: DeliverableActionSentinelEvidence = {
        tasks_in_window: 0,
        flagged_tasks: 0,
        narrated_failure_rate_6h: 0,
        flagged: [],
        by_action_type: {},
        __tracked_field: 'narrated_failure_rate_6h',
      };
      return { subject: 'deliverable-action:summary', summary: 'query failed; skipping', evidence };
    }

    const flagged: FlaggedTask[] = [];
    const byType = new Map<string, number>();
    for (const row of rows) {
      const deferred = parseDeferred(row.deferred_action);
      const actionType = typeof deferred?.type === 'string' ? deferred.type : 'unknown';
      const canary = matchCanary(row.output);
      if (!canary) continue;
      byType.set(actionType, (byType.get(actionType) ?? 0) + 1);
      if (flagged.length < 5) {
        flagged.push({
          task_id: row.id,
          title: row.title ?? '(untitled)',
          action_type: actionType,
          canary,
          output_preview: (row.output ?? '').trim().slice(0, 240),
        });
      }
    }

    const rate = rows.length === 0 ? 0 : flagged.length / rows.length;

    const evidence: DeliverableActionSentinelEvidence = {
      tasks_in_window: rows.length,
      flagged_tasks: flagged.length,
      narrated_failure_rate_6h: rate,
      flagged,
      by_action_type: Object.fromEntries(byType),
      __tracked_field: 'narrated_failure_rate_6h',
    };

    let summary: string;
    if (rows.length === 0) {
      summary = 'no deferred-action tasks completed in last 6h';
    } else if (flagged.length === 0) {
      summary = `${rows.length} deferred-action task(s) completed, none narrated a failure`;
    } else {
      const topType = [...byType.entries()].sort((a, b) => b[1] - a[1])[0];
      summary = `${flagged.length}/${rows.length} deferred-action task(s) narrated failure (${topType[0]} ×${topType[1]}); canary "${flagged[0].canary}"`;
    }

    return { subject: 'deliverable-action:summary', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as DeliverableActionSentinelEvidence;
    if (ev.flagged_tasks < MIN_SAMPLES) return 'pass';
    if (
      ev.flagged_tasks >= MIN_FAIL_SAMPLES &&
      ev.narrated_failure_rate_6h >= FAIL_RATE
    ) {
      return 'fail';
    }
    return 'warning';
  }
}
