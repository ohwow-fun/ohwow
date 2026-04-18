/**
 * LlmBudgetPulseExperiment — weekly "where is the autonomous spend going?" check.
 *
 * Gap 13 landing pad for the observability slot. Revenue-pulse covers the
 * "is the loop making money?" question; this one answers the matching
 * "is the loop burning money on anything worth watching?" side. Rollups
 * the last 7 days of `llm_calls` rows tagged `origin='autonomous'`,
 * buckets them by UTC date, and names the top-3 experiment_ids by
 * cost_cents. Observer-only: verdict is always `pass`, the narrative
 * IS the value.
 *
 * Shape copied from revenue-pulse.ts: 60min cadence, runOnBoot=true,
 * inner day-key dedupe so only one finding emits per UTC day (regardless
 * of how many ticks fire in between). Skip rows are cheap — keeps the
 * ledger honest about what ran when.
 *
 * Output: one `self_findings` row with subject = `llm-budget:YYYY-MM-DD`
 * and a summary in Result / Threshold / Next-Move shape. Evidence
 * captures the 7-day total, today's running total, per-day breakdown,
 * the top-3 experiment_id × cents pairs, and the autonomous call
 * count so downstream readers (digest, strategist) can decide whether
 * the burn is concentrated on a single experiment or spread thin.
 */

import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { listFindings } from '../findings-store.js';

const CADENCE = { everyMs: 60 * 60 * 1000, runOnBoot: true };
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const TOP_EXPERIMENTS = 3;

interface LlmCallRow {
  workspace_id: string;
  origin: string;
  experiment_id: string | null;
  cost_cents: number;
  created_at: string;
}

function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

export interface LlmBudgetPulseEvidence extends Record<string, unknown> {
  span_days: number;
  total_cents_7d: number;
  cents_today: number;
  cents_by_day: Record<string, number>;
  top_experiments: Array<{ id: string; cents: number }>;
  autonomous_call_count: number;
}

export class LlmBudgetPulseExperiment implements Experiment {
  readonly id = 'llm-budget-pulse';
  readonly name = 'LLM budget pulse (weekly autonomous-spend rollup)';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'A daily digest of autonomous LLM spend over a 7-day window, broken down by experiment_id, gives the operator (and the autonomous loop) a fast read on which experiments are spending without producing proportional signal. Observer-only: no fail threshold, the narrative IS the value.';
  readonly cadence = CADENCE;

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const now = new Date();
    const dk = dayKey(now);

    // Day-key dedupe: if the last finding for this experiment already
    // landed today, emit a lightweight skip row. Cheap restart-safety;
    // a daemon that bounces at 23:59 and again at 00:01 shouldn't
    // double-count the day boundary.
    const prior = await listFindings(ctx.db, { experimentId: this.id, limit: 1 });
    if (prior[0]?.ranAt && dayKey(new Date(prior[0].ranAt)) === dk) {
      return {
        subject: `llm-budget:${dk}`,
        summary: `Result: llm-budget pulse already landed this UTC day at ${prior[0].ranAt}.\nThreshold: one pulse per UTC day max.\nNext Move: skipped (dedupe); no new signal to emit.`,
        evidence: { span_days: 7, skipped: true, day: dk } as LlmBudgetPulseEvidence & { skipped: boolean; day: string },
      };
    }

    const nowMs = now.getTime();
    const since7d = new Date(nowMs - WEEK_MS).toISOString();
    const rows = await this.readLlmCalls(ctx, since7d);

    const todayCut = nowMs - DAY_MS;
    const centsByDay: Record<string, number> = {};
    const centsByExperiment = new Map<string, number>();
    let totalCents = 0;
    let centsToday = 0;
    let callCount = 0;

    for (const r of rows) {
      if (r.origin !== 'autonomous') continue;
      const ts = new Date(r.created_at).getTime();
      if (Number.isNaN(ts)) continue;
      const cost = Number(r.cost_cents) || 0;
      totalCents += cost;
      callCount += 1;
      const rowDayKey = r.created_at.slice(0, 10);
      centsByDay[rowDayKey] = (centsByDay[rowDayKey] ?? 0) + cost;
      if (ts >= todayCut) centsToday += cost;
      const expKey = r.experiment_id && r.experiment_id.length > 0 ? r.experiment_id : 'unattributed';
      centsByExperiment.set(expKey, (centsByExperiment.get(expKey) ?? 0) + cost);
    }

    const topExperiments = [...centsByExperiment.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_EXPERIMENTS)
      .map(([id, cents]) => ({ id, cents }));

    const evidence: LlmBudgetPulseEvidence = {
      span_days: 7,
      total_cents_7d: totalCents,
      cents_today: centsToday,
      cents_by_day: centsByDay,
      top_experiments: topExperiments,
      autonomous_call_count: callCount,
    };

    const topStr = topExperiments.length === 0
      ? 'none'
      : topExperiments.map((e) => `${e.id} $${(e.cents / 100).toFixed(2)}`).join(', ');

    const summary = [
      `Result: autonomous LLM spend $${(totalCents / 100).toFixed(2)} over the last 7d (${callCount} calls); $${(centsToday / 100).toFixed(2)} so far today.`,
      'Threshold: observer-only; no fail threshold today. The burn-guard handles runaway-loop halts; this pulse names the spenders.',
      `Next Move: top-3 by cost: ${topStr}. If one experiment dominates and isn't producing warning/fail findings, it's a defund candidate; see experiment-cost-observer for the paired signal-per-dollar view.`,
    ].join('\n');

    return { subject: `llm-budget:${dk}`, summary, evidence };
  }

  judge(_result: ProbeResult, _history: Finding[]): Verdict {
    // Observer only. The narrative IS the value; don't pollute the
    // warning/fail reactive-reschedule stream with a reporting pulse.
    return 'pass';
  }

  private async readLlmCalls(ctx: ExperimentContext, since: string): Promise<LlmCallRow[]> {
    try {
      const { data } = await ctx.db
        .from<LlmCallRow>('llm_calls')
        .select('workspace_id, origin, experiment_id, cost_cents, created_at')
        .eq('workspace_id', ctx.workspaceId)
        .eq('origin', 'autonomous')
        .gte('created_at', since)
        .limit(50_000);
      return (data ?? []) as LlmCallRow[];
    } catch {
      return [];
    }
  }
}
