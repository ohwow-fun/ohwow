/**
 * TriggerStabilityExperiment — second concrete Experiment.
 *
 * Wraps the E2 trigger watchdog as a scheduled experiment. The watchdog
 * itself already updates local_triggers.consecutive_failures on every
 * task finalization and emits a trigger_stuck activity when the
 * threshold is crossed — this experiment just polls the table so the
 * health of the trigger queue becomes a first-class finding in the
 * ledger.
 *
 * The probe returns a snapshot of every trigger with
 * consecutive_failures > 0 (not just stuck ones — a count of 1 or 2 is
 * useful drift signal). The judge returns:
 *   - 'pass' when no trigger has any consecutive failures
 *   - 'warning' when at least one has 1-2 consecutive failures
 *   - 'fail' when at least one is at or above TRIGGER_STUCK_THRESHOLD
 *
 * No intervene — the watchdog itself already wrote the activity row
 * at threshold crossing. This experiment is pure observation; the
 * value is the finding landing in the ledger so the meta-loop and
 * future Claude sessions can query "when did trigger X last go
 * stuck" without walking activity logs.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { TRIGGER_STUCK_THRESHOLD } from '../../triggers/trigger-watchdog.js';

interface TriggerRowShape {
  id: string;
  name: string;
  consecutive_failures: number | null;
  last_succeeded_at: string | null;
  last_fired_at: string | null;
  enabled: number;
}

interface TriggerStabilityEvidence extends Record<string, unknown> {
  failing_triggers: Array<{
    id: string;
    name: string;
    consecutive_failures: number;
    last_succeeded_at: string | null;
    last_fired_at: string | null;
    enabled: boolean;
  }>;
  stuck_count: number;
  warning_count: number;
  threshold: number;
}

export class TriggerStabilityExperiment implements Experiment {
  id = 'trigger-stability';
  name = 'Scheduled trigger health';
  category = 'trigger_stability' as const;
  hypothesis =
    'Every enabled local_trigger completes its most recent fire without accumulating consecutive failures — silent cron miscarriages stay at zero.';
  cadence = { everyMs: 5 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const { data } = await ctx.db
      .from<TriggerRowShape>('local_triggers')
      .select('id, name, consecutive_failures, last_succeeded_at, last_fired_at, enabled')
      .gte('consecutive_failures', 1)
      .order('consecutive_failures', { ascending: false });

    const rows = (data ?? []) as TriggerRowShape[];
    const failing = rows.map((r) => ({
      id: r.id,
      name: r.name,
      consecutive_failures: r.consecutive_failures ?? 0,
      last_succeeded_at: r.last_succeeded_at,
      last_fired_at: r.last_fired_at,
      enabled: r.enabled === 1,
    }));

    const stuckCount = failing.filter((f) => f.consecutive_failures >= TRIGGER_STUCK_THRESHOLD).length;
    const warningCount = failing.length - stuckCount;

    const evidence: TriggerStabilityEvidence = {
      failing_triggers: failing,
      stuck_count: stuckCount,
      warning_count: warningCount,
      threshold: TRIGGER_STUCK_THRESHOLD,
    };

    const summary = failing.length === 0
      ? 'all triggers healthy'
      : stuckCount > 0
        ? `${stuckCount} trigger(s) stuck at ≥${TRIGGER_STUCK_THRESHOLD} consecutive failures; ${warningCount} more with 1-2 failures`
        : `${warningCount} trigger(s) with 1-2 consecutive failures (below stuck threshold)`;

    const subject = failing.length > 0 ? `trigger:${failing[0].id}` : null;
    return { subject, summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as TriggerStabilityEvidence;
    if (ev.failing_triggers.length === 0) return 'pass';
    if (ev.stuck_count > 0) return 'fail';
    return 'warning';
  }
}
