/**
 * OpsPulseExperiment — hourly snapshot of operational knobs.
 *
 * Sibling to RevenuePulseExperiment. Revenue Pulse asks "did we make
 * money in the last hour?"; Ops Pulse asks "are the operational
 * levers in a shape that could make money?". Together they give the
 * loop two orthogonal telos signals: money (outcome) + ops (process).
 *
 * This is the foundation probe for the ops-telos phase. It does NOT
 * mutate anything. It reads every knob in OPS_KNOBS, reads the
 * latest x-ops-observer finding for live dispatch/approval signals,
 * and emits a narrative Result / Threshold / Next Move row.
 *
 * Mutation experiments come later, gated by their own tier-2 path
 * and Fixes-Finding-Id receipts (same safety envelope as patch-author).
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
import { readAllKnobs, type OpsKnobReading } from '../ops-knobs.js';

const CADENCE = { everyMs: 60 * 60 * 1000, runOnBoot: true };

function hourKey(now = new Date()): string { return now.toISOString().slice(0, 13); }

interface XOpsEv {
  posts_24h?: number;
  approvals_counted?: number;
  dispatch_success_rate?: number;
  approval_ratio?: number;
}

export interface OpsPulseEvidence extends Record<string, unknown> {
  hour: string;
  knobs: OpsKnobReading[];
  knobs_out_of_range: string[];
  posts_24h: number | null;
  approvals_counted: number | null;
  dispatch_success_rate: number | null;
  next_move: string;
}

export class OpsPulseExperiment implements Experiment {
  readonly id = 'ops-pulse';
  readonly name = 'Ops pulse (hourly operational-knobs snapshot)';
  readonly category: ExperimentCategory = 'business_outcome';
  readonly hypothesis =
    'The autonomous loop can only optimize what it can see. An hourly snapshot of the current operational-knob values (posting target, approval threshold, burn cap) + live ops outcomes (dispatch rate, approval ratio) gives the loop a single place to reason about the process-side of the money telos, separate from the outcome-side that Revenue Pulse tracks.';
  readonly cadence = CADENCE;

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const now = new Date();
    const hk = hourKey(now);

    const prior = await listFindings(ctx.db, { experimentId: this.id, limit: 1 });
    if (prior[0]?.ranAt && hourKey(new Date(prior[0].ranAt)) === hk) {
      return {
        subject: `ops:${hk}`,
        summary: `Result: ops-pulse already ran this hour at ${prior[0].ranAt}.\nThreshold: one pulse per hour max.\nConclusion: skipped (dedupe); no new snapshot emitted.`,
        evidence: { hour: hk, skipped: true },
      };
    }

    const knobs = await readAllKnobs();
    const outOfRange = knobs
      .filter((k) => k.in_range === false)
      .map((k) => k.key);

    const xops = await this.latestXOps(ctx);
    const evidence: OpsPulseEvidence = {
      hour: hk,
      knobs,
      knobs_out_of_range: outOfRange,
      posts_24h: xops?.posts_24h ?? null,
      approvals_counted: xops?.approvals_counted ?? null,
      dispatch_success_rate: xops?.dispatch_success_rate ?? null,
      next_move: decideOpsMove(knobs, xops),
    };

    const knobLines = knobs.map((k) => {
      const v = k.value === null ? 'null' : typeof k.value === 'boolean' ? String(k.value) : fmt(k.value, k.unit);
      const tag = k.in_range === false ? ' [OUT-OF-RANGE]' : '';
      return `  ${k.key}=${v}${tag}`;
    }).join('\n');

    const summary = [
      `Result: ops knob snapshot for ${hk}Z.\n${knobLines}`,
      `Threshold: warn if any knob is out of its sane range, or dispatch_success_rate < 0.7, or approvals_counted = 0 in 48h.`,
      `Next Move: ${evidence.next_move}`,
    ].join('\n');

    return { subject: `ops:${hk}`, summary, evidence };
  }

  judge(result: ProbeResult, _h: Finding[]): Verdict {
    const ev = result.evidence as OpsPulseEvidence & { skipped?: boolean };
    if (ev.skipped) return 'pass';
    if (ev.knobs_out_of_range.length > 0) return 'warning';
    if (ev.dispatch_success_rate !== null && ev.dispatch_success_rate < 0.5) return 'warning';
    return 'pass';
  }

  private async latestXOps(ctx: ExperimentContext): Promise<XOpsEv | null> {
    try {
      const rows = await listFindings(ctx.db, { experimentId: 'x-ops-observer', limit: 1 });
      const ev = rows[0]?.evidence;
      return ev && typeof ev === 'object' ? (ev as XOpsEv) : null;
    } catch { return null; }
  }
}

function fmt(n: number, unit: string): string {
  if (unit === 'cents') return `$${(n / 100).toFixed(2)}`;
  if (unit === 'ratio') return n.toFixed(2);
  return String(n);
}

export function decideOpsMove(knobs: OpsKnobReading[], xops: XOpsEv | null): string {
  const byKey = new Map(knobs.map((k) => [k.key, k]));
  const deficit = byKey.get('x_compose.weekly_deficit')?.value;
  const actual = byKey.get('x_compose.weekly_actual')?.value;
  const burnCap = byKey.get('burn.daily_cap_cents')?.value;
  const dispatch = xops?.dispatch_success_rate ?? null;

  if (typeof deficit === 'number' && deficit > 2) {
    return `posting under target by ${deficit} posts this week. Highest-leverage move: bump x_compose autonomy — raise allowlist coverage or relax auto_approve_after thresholds.`;
  }
  if (typeof actual === 'number' && actual === 0) {
    return 'zero posts this week. Something upstream is blocking — check x-ops-observer dispatch_success_rate and the approval queue for stuck items.';
  }
  if (dispatch !== null && dispatch < 0.5) {
    return `dispatch_success_rate is ${dispatch.toFixed(2)} (< 0.5). Highest-leverage move: audit x-compose failures — the ops loop is queuing posts that don't land.`;
  }
  if (burnCap === null) {
    return 'no daily burn cap in force. Foundation gap: wire burn.daily_cap_cents as a real enforced knob so experiment-cost-observer can trigger throttling.';
  }
  return 'ops knobs look sane. Use Revenue Pulse next-move to pick the outcome-side lever.';
}
