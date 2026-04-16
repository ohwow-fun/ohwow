/**
 * backfillNarratedFailures — one-off cleanup primitive for the class
 * of historical tasks that landed as status='completed' despite their
 * agent narration containing an auth / permission / infra-failure
 * canary.
 *
 * Why this exists
 * ---------------
 * Commit 7bf64bb (2026-04-16 07:32 local) added a narrated-failure
 * gate in task-completion.ts that routes deferred-action tasks to
 * failed when the final content trips a canary. The gate is FORWARD-
 * looking: it only fires when new tasks complete. Every pre-gate task
 * — and every post-gate task the still-running daemon completed before
 * picking up the new bundle — stayed at status='completed'.
 *
 * Those rows are not inert. content-cadence-scheduler counts them as
 * posts_today, the x_posts_per_week goal's current_value is derived
 * from them, and the trust-output executor treats them as delivered
 * work. The money-machine metric surface reads "healthy posting cadence"
 * while zero posts actually went out — the exact failure mode the gate
 * was written to prevent, now silently accumulated in history.
 *
 * This module gives an operator (or a future daemon-boot hook) one
 * pure function to re-scan the historical window and correct the
 * rows. Same canary set as the live gate — any divergence would
 * create a disconnect between "what the sentinel flagged" and "what
 * was actually rerouted", which operators would read as either a
 * false positive or a missed one.
 *
 * Intentionally NOT wired into daemon/start.ts yet. A destructive-ish
 * pass that rewrites historical truth should run under explicit
 * operator invocation the first time — not as a silent boot side
 * effect that surprises someone with rerouted rows they didn't
 * expect. Once the semantics are blessed, wire it to boot with a
 * one-shot marker in runtime_config_overrides.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { NARRATED_FAILURE_CANARIES } from '../self-bench/experiments/deliverable-action-sentinel.js';

export interface NarratedFailureHit {
  task_id: string;
  title: string | null;
  completed_at: string | null;
  action_type: string;
  canary: string;
  output_preview: string;
}

export interface BackfillNarratedFailuresResult {
  /** Total completed deferred-action rows inspected in the window. */
  scanned: number;
  /** Rows whose output matched a canary. Ordered newest-first. */
  flagged: NarratedFailureHit[];
  /** Rows that were actually rerouted to failed. 0 when dryRun. */
  applied: number;
  /**
   * Linked agent_workforce_deliverables rows that were flipped from
   * status='approved' to 'rejected' because the parent task is a
   * narrated failure. These rows are landmines if left 'approved':
   * their content.text is a capitulation narration like "I don't
   * have credentials to post", and if DeliverableExecutor fires on
   * them it will literally post that narration as a tweet. Always
   * reroute alongside the parent task.
   */
  deliverablesRerouted: number;
}

export interface BackfillNarratedFailuresOptions {
  /**
   * Only look at tasks whose completed_at is ≥ this ISO timestamp.
   * Omit to scan every historical row — which is fine on a small
   * workspace but a lot of DB reads on a large one, hence the knob.
   */
  since?: string;
  /**
   * When true (default), flag candidates but don't write to the DB.
   * Operator runs dryRun=true once to inspect, then dryRun=false to
   * apply. No partial-application surface: either we rewrite every
   * flagged row or none.
   */
  dryRun?: boolean;
  /** Cap the number of inspected rows. Defaults to 5000 — large
   *  enough for any realistic backfill window, small enough to bound
   *  DB load. Rows beyond the cap are silently dropped; callers that
   *  need exhaustive scans should paginate. */
  limit?: number;
}

interface CandidateRow {
  id: string;
  title: string | null;
  status: string;
  output: string | null;
  deferred_action: string | Record<string, unknown> | null;
  completed_at: string | null;
}

interface DeferredShape {
  type?: unknown;
}

function parseDeferred(raw: string | Record<string, unknown> | null): DeferredShape | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as DeferredShape;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as DeferredShape) : null;
  } catch {
    return null;
  }
}

function matchCanary(output: string | null): string | null {
  if (!output) return null;
  const lower = output.toLowerCase();
  for (const phrase of NARRATED_FAILURE_CANARIES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * Scan completed deferred-action tasks for narrated-failure canaries
 * and optionally reroute them to status='failed'. Safe to call
 * repeatedly — idempotent once a row has been moved off 'completed',
 * it no longer matches the scan.
 */
export async function backfillNarratedFailures(
  db: DatabaseAdapter,
  opts: BackfillNarratedFailuresOptions = {},
): Promise<BackfillNarratedFailuresResult> {
  const dryRun = opts.dryRun !== false;
  const limit = opts.limit ?? 5000;

  const base = db
    .from('agent_workforce_tasks')
    .select('id, title, status, output, deferred_action, completed_at')
    .eq('status', 'completed')
    .not('deferred_action', 'is', null);
  const windowed = opts.since ? base.gte('completed_at', opts.since) : base;
  const result = await windowed
    .order('completed_at', { ascending: false })
    .limit(limit);
  const rows = ((result.data ?? []) as unknown as CandidateRow[]).filter(
    (r) => r && r.deferred_action,
  );

  const flagged: NarratedFailureHit[] = [];
  for (const row of rows) {
    const canary = matchCanary(row.output);
    if (!canary) continue;
    const deferred = parseDeferred(row.deferred_action);
    const actionType = typeof deferred?.type === 'string' ? deferred.type : 'unknown';
    flagged.push({
      task_id: row.id,
      title: row.title,
      completed_at: row.completed_at,
      action_type: actionType,
      canary,
      output_preview: (row.output ?? '').trim().slice(0, 240),
    });
  }

  let applied = 0;
  let deliverablesRerouted = 0;
  if (!dryRun && flagged.length > 0) {
    const nowIso = new Date().toISOString();
    for (const hit of flagged) {
      const taskPatch: Record<string, unknown> = {
        status: 'failed',
        failure_category: 'narrated_failure_backfill',
        error_message: `Backfilled to failed: narration contained canary "${hit.canary}" (action ${hit.action_type}). Task was marked completed before the narrated-failure gate covered this window.`,
        updated_at: nowIso,
      };
      const { error } = await db
        .from('agent_workforce_tasks')
        .update(taskPatch)
        .eq('id', hit.task_id);
      if (error) continue;
      applied++;

      // Linked deliverables: whatever the agent stamped as the action's
      // content is the capitulation narration itself — not a postable
      // tweet. Leaving them at 'approved' means DeliverableExecutor
      // could later post them for real. Flip to 'rejected' with a
      // reason that matches the parent task's failure_category so
      // audits cross-reference cleanly.
      const { data: deliverables } = await db
        .from('agent_workforce_deliverables')
        .select('id')
        .eq('task_id', hit.task_id)
        .eq('status', 'approved');
      const ids = ((deliverables ?? []) as Array<{ id: string }>).map((d) => d.id);
      for (const id of ids) {
        const { error: dErr } = await db
          .from('agent_workforce_deliverables')
          .update({
            status: 'rejected',
            rejection_reason: `narrated_failure_backfill: parent task routed to failed; content was a capitulation narration (canary "${hit.canary}"), not a postable tweet.`,
            updated_at: nowIso,
          })
          .eq('id', id);
        if (!dErr) deliverablesRerouted++;
      }
    }
  }

  return { scanned: rows.length, flagged, applied, deliverablesRerouted };
}
