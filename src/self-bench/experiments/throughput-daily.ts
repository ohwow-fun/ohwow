/**
 * ThroughputDailyExperiment — day-over-day task completion summary.
 *
 * Cold-prompt readers need a quick "shipping faster or slower than
 * yesterday?" answer that doesn't require grepping agent_workforce_*
 * or joining multiple tables. This probe does the join once per
 * cadence and writes the number to the ledger as meta:throughput-daily.
 *
 * Counts tasks with status='completed' whose completed_at falls in
 * each 24h bucket. Failures don't count as throughput — a completed
 * task is one that the agent actually delivered.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

interface TaskRow {
  workspace_id: string;
  status: string;
  completed_at: string | null;
}

interface ThroughputEvidence extends Record<string, unknown> {
  completed_today: number;
  completed_yesterday: number;
  delta: number;
  pct_change: number | null;
  window_hours: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class ThroughputDailyExperiment implements Experiment {
  readonly id = 'throughput-daily';
  readonly name = 'Day-over-day task throughput';
  readonly category = 'business_outcome' as const;
  readonly hypothesis =
    'Completed-task throughput either holds steady or trends up day-over-day as the workforce gets used.';
  readonly cadence = { everyMs: 15 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const now = Date.now();
    const since48h = new Date(now - 2 * DAY_MS).toISOString();

    let rows: TaskRow[] = [];
    try {
      const { data } = await ctx.db
        .from<TaskRow>('agent_workforce_tasks')
        .select('workspace_id, status, completed_at')
        .eq('workspace_id', ctx.workspaceId)
        .eq('status', 'completed')
        .gte('completed_at', since48h)
        .limit(10_000);
      rows = (data ?? []) as TaskRow[];
    } catch (err) {
      return {
        subject: 'meta:throughput-daily',
        summary: `throughput probe failed: ${err instanceof Error ? err.message : String(err)}`,
        evidence: {
          completed_today: 0,
          completed_yesterday: 0,
          delta: 0,
          pct_change: null,
          window_hours: 24,
          error: true,
        } satisfies ThroughputEvidence & { error: boolean },
      };
    }

    const todayCut = now - DAY_MS;
    let today = 0;
    let yesterday = 0;
    for (const r of rows) {
      if (!r.completed_at) continue;
      const ts = new Date(r.completed_at).getTime();
      if (Number.isNaN(ts)) continue;
      if (ts >= todayCut) today += 1;
      else yesterday += 1;
    }

    const delta = today - yesterday;
    const pctChange =
      yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 100) : null;

    const evidence: ThroughputEvidence = {
      completed_today: today,
      completed_yesterday: yesterday,
      delta,
      pct_change: pctChange,
      window_hours: 24,
    };

    const deltaStr =
      pctChange === null
        ? yesterday === 0 && today === 0
          ? 'no completions yet'
          : `first measurable day (${today})`
        : `${today} vs ${yesterday} (${pctChange >= 0 ? '+' : ''}${pctChange}%)`;

    return {
      subject: 'meta:throughput-daily',
      summary: `throughput: ${deltaStr}`,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as ThroughputEvidence & { error?: boolean };
    if (ev.error) return 'warning';
    // Observer-only. Warn when throughput drops by more than half
    // day-over-day — catches "the agents stopped working" without
    // crying wolf on normal variance.
    if (ev.completed_yesterday > 0 && ev.completed_today * 2 < ev.completed_yesterday)
      return 'warning';
    return 'pass';
  }
}
