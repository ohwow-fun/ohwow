/**
 * AttributionObserverExperiment — Funnel Surgeon Phase 1 observer.
 *
 * Reads agent_workforce_attribution_rollup (migration 128) and asks
 * the operator's questions:
 *   - What share of qualified leads become paid?
 *   - How long does the median buyer take to reach plan:paid?
 *   - Which acquisition bucket converts worst?
 *
 * Writes a compact, human-readable JSON blob into runtime_config
 * under `strategy.attribution_findings` so the strategist's distilled
 * view surfaces the answer alongside revenue_gap_focus. Writes only —
 * no outbound actions, no task creation, no side effects beyond the
 * single runtime_config key. Pattern mirrors RevenuePipelineObserver.
 *
 * Cadence: 6h. Attribution metrics don't move fast enough to justify
 * hourly probes; too-fast cadence just floods the findings ledger.
 *
 * Verdict policy:
 *   pass    — fewer than MIN_QUALIFIED_FOR_SIGNAL qualified rows in
 *             the view (not enough data to say anything useful) OR
 *             every bucket with ≥ MIN_BUCKET_N qualified has a
 *             non-zero conversion_rate.
 *   warning — at least one bucket with ≥ MIN_BUCKET_N qualified has
 *             a zero conversion_rate OR the overall conversion_rate
 *             dropped below CONVERSION_WARN_FRACTION of the previous
 *             finding's rate (regression guard).
 *   fail    — not used in v1. This experiment exists to surface; the
 *             strategist decides what to do with the signal.
 *
 * No validate() / rollback() — the observer writes a pure advisory
 * key that's overwritten on every probe, so there's nothing to
 * re-probe or undo.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';
import {
  BusinessExperiment,
  type BusinessExperimentOptions,
} from '../business-experiment.js';
import type {
  ExperimentCadence,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { setRuntimeConfig } from '../runtime-config.js';

// runOnBoot: true so the ranker's `strategy.attribution_findings`
// config key gets populated within the first tick after a daemon
// restart instead of leaving a 6h blindspot. The sibling
// RevenuePipelineObserver already runs on boot for the same reason —
// the ranker treats both keys as required inputs for the revenue-
// proximity pick. Observed 2026-04-16: ATTRIBUTION_FINDINGS_MISSING
// + CITES_SALES_SIGNAL_ABSENT fired in tandem because an autonomous
// patch landed before this observer had had a chance to tick.
const CADENCE: ExperimentCadence = { everyMs: 6 * 60 * 60 * 1000, runOnBoot: true };
/** Minimum rows with a qualified_ts before the observer says anything. */
const MIN_QUALIFIED_FOR_SIGNAL = 3;
/** Minimum rows in a bucket before a per-bucket conversion rate is meaningful. */
const MIN_BUCKET_N = 3;
/** Zero conversion in a meaningful bucket triggers a warning. */
const ZERO_CONVERSION_WARN_THRESHOLD = 0;

interface RollupRow {
  contact_id: string;
  workspace_id: string;
  bucket: string | null;
  source: string | null;
  first_seen_ts: string | null;
  qualified_ts: string | null;
  reached_ts: string | null;
  demo_ts: string | null;
  trial_ts: string | null;
  paid_ts: string | null;
  lifetime_revenue_cents: number | null;
}

interface BucketStats {
  bucket: string;
  qualified: number;
  paid: number;
  conversion_rate: number;
  median_days_to_paid: number | null;
  total_revenue_cents: number;
}

interface SourceStats {
  source: string;
  qualified: number;
  paid: number;
  median_days_to_paid: number | null;
}

export interface AttributionEvidence extends Record<string, unknown> {
  total_contacts: number;
  total_qualified: number;
  total_paid: number;
  overall_conversion_rate: number;
  median_days_to_paid: number | null;
  by_bucket: BucketStats[];
  by_source: SourceStats[];
  worst_performing_bucket: BucketStats | null;
  lifetime_revenue_cents: number;
  __tracked_field: 'overall_conversion_rate';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function daysBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, (end - start) / (24 * 60 * 60 * 1000));
}

function computeBucketStats(rows: RollupRow[]): BucketStats[] {
  const byBucket = new Map<string, RollupRow[]>();
  for (const r of rows) {
    const key = r.bucket ?? 'unknown';
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key)!.push(r);
  }
  const out: BucketStats[] = [];
  for (const [bucket, bucketRows] of byBucket) {
    const qualifiedRows = bucketRows.filter((r) => r.qualified_ts);
    const paidRows = qualifiedRows.filter((r) => r.paid_ts);
    const daysToPaid = paidRows
      .map((r) => daysBetween(r.qualified_ts as string, r.paid_ts as string));
    const totalRevenue = bucketRows.reduce((sum, r) => sum + Number(r.lifetime_revenue_cents ?? 0), 0);
    out.push({
      bucket,
      qualified: qualifiedRows.length,
      paid: paidRows.length,
      conversion_rate: qualifiedRows.length === 0 ? 0 : paidRows.length / qualifiedRows.length,
      median_days_to_paid: median(daysToPaid),
      total_revenue_cents: totalRevenue,
    });
  }
  return out.sort((a, b) => b.qualified - a.qualified);
}

function computeSourceStats(rows: RollupRow[]): SourceStats[] {
  const bySource = new Map<string, RollupRow[]>();
  for (const r of rows) {
    const key = r.source ?? 'unknown';
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push(r);
  }
  const out: SourceStats[] = [];
  for (const [source, srcRows] of bySource) {
    const qualifiedRows = srcRows.filter((r) => r.qualified_ts);
    const paidRows = qualifiedRows.filter((r) => r.paid_ts);
    const daysToPaid = paidRows
      .map((r) => daysBetween(r.qualified_ts as string, r.paid_ts as string));
    out.push({
      source,
      qualified: qualifiedRows.length,
      paid: paidRows.length,
      median_days_to_paid: median(daysToPaid),
    });
  }
  return out.sort((a, b) => b.qualified - a.qualified);
}

export class AttributionObserverExperiment extends BusinessExperiment {
  readonly id = 'attribution-observer';
  readonly name = 'Attribution observer';
  readonly hypothesis =
    'Once plan:paid events start flowing from Stripe, the attribution rollup view lets us see which acquisition buckets convert and how quickly. Any bucket with ≥3 qualified leads and zero conversions is a finding the operator should see at the top of the distilled view.';
  readonly cadence = CADENCE;

  constructor(opts: BusinessExperimentOptions = {}) {
    super(opts);
  }

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    let rows: RollupRow[] = [];
    try {
      const res = await (ctx.db as DatabaseAdapter)
        .from<RollupRow>('agent_workforce_attribution_rollup')
        .select('contact_id, workspace_id, bucket, source, first_seen_ts, qualified_ts, reached_ts, demo_ts, trial_ts, paid_ts, lifetime_revenue_cents')
        .eq('workspace_id', ctx.workspaceId);
      rows = ((res as { data?: RollupRow[] | null }).data ?? []) as RollupRow[];
    } catch (err) {
      logger.warn({ err }, '[attribution-observer] view read failed');
    }

    const totalContacts = rows.length;
    const qualifiedRows = rows.filter((r) => r.qualified_ts);
    const paidRows = qualifiedRows.filter((r) => r.paid_ts);
    const overallConversionRate = qualifiedRows.length === 0
      ? 0
      : paidRows.length / qualifiedRows.length;
    const daysToPaid = paidRows.map((r) => daysBetween(r.qualified_ts as string, r.paid_ts as string));
    const totalRevenue = rows.reduce((sum, r) => sum + Number(r.lifetime_revenue_cents ?? 0), 0);
    const byBucket = computeBucketStats(rows);
    const bySource = computeSourceStats(rows);

    // Worst-performing bucket: among buckets with enough sample size,
    // pick the one with the lowest conversion rate. Ties broken by
    // qualified count (higher n is more concerning at same rate).
    const candidateBuckets = byBucket.filter((b) => b.qualified >= MIN_BUCKET_N);
    const worst = candidateBuckets.length === 0
      ? null
      : candidateBuckets.reduce((acc, b) => {
          if (b.conversion_rate < acc.conversion_rate) return b;
          if (b.conversion_rate === acc.conversion_rate && b.qualified > acc.qualified) return b;
          return acc;
        }, candidateBuckets[0]);

    const evidence: AttributionEvidence = {
      total_contacts: totalContacts,
      total_qualified: qualifiedRows.length,
      total_paid: paidRows.length,
      overall_conversion_rate: Math.round(overallConversionRate * 1000) / 1000,
      median_days_to_paid: median(daysToPaid),
      by_bucket: byBucket,
      by_source: bySource,
      worst_performing_bucket: worst,
      lifetime_revenue_cents: totalRevenue,
      __tracked_field: 'overall_conversion_rate',
    };

    const summary = qualifiedRows.length < MIN_QUALIFIED_FOR_SIGNAL
      ? `${qualifiedRows.length} qualified (need ≥${MIN_QUALIFIED_FOR_SIGNAL} for meaningful stats); ${paidRows.length} paid, mtd $${(totalRevenue / 100).toFixed(0)}`
      : `${paidRows.length}/${qualifiedRows.length} qualified → paid (${(overallConversionRate * 100).toFixed(0)}%), median ${evidence.median_days_to_paid ?? '?'}d, worst=${worst?.bucket ?? 'n/a'}@${((worst?.conversion_rate ?? 0) * 100).toFixed(0)}%`;

    return { subject: 'attribution:rollup', summary, evidence };
  }

  protected businessJudge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as AttributionEvidence;
    if (ev.total_qualified < MIN_QUALIFIED_FOR_SIGNAL) return 'pass';
    const worst = ev.worst_performing_bucket;
    if (worst && worst.qualified >= MIN_BUCKET_N && worst.conversion_rate <= ZERO_CONVERSION_WARN_THRESHOLD) {
      return 'warning';
    }
    return 'pass';
  }

  protected async businessIntervene(
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as AttributionEvidence;
    // Always write, even on pass — the strategist view is keyed on the
    // latest value of `strategy.attribution_findings` and a stale
    // "warning" blob from an earlier cycle would mislead if this cycle
    // actually passed. Intervene every tick; the findings ledger
    // captures the verdict delta.
    const findings = {
      verdict,
      total_qualified: ev.total_qualified,
      total_paid: ev.total_paid,
      overall_conversion_rate: ev.overall_conversion_rate,
      median_days_to_paid: ev.median_days_to_paid,
      worst_performing_bucket: ev.worst_performing_bucket ? {
        bucket: ev.worst_performing_bucket.bucket,
        qualified: ev.worst_performing_bucket.qualified,
        paid: ev.worst_performing_bucket.paid,
        conversion_rate: ev.worst_performing_bucket.conversion_rate,
      } : null,
      lifetime_revenue_cents: ev.lifetime_revenue_cents,
      computed_at: new Date().toISOString(),
    };
    try {
      await setRuntimeConfig(ctx.db, 'strategy.attribution_findings', findings, { setBy: this.id });
    } catch (err) {
      logger.warn({ err }, '[attribution-observer] setRuntimeConfig failed');
      return null;
    }
    return {
      description: `attribution findings updated (verdict=${verdict}, qualified=${ev.total_qualified}, paid=${ev.total_paid})`,
      details: {
        config_keys: ['strategy.attribution_findings'],
        verdict,
        reversible: true,
      },
    };
  }
}
