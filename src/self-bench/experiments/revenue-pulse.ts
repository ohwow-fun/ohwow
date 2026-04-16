/**
 * RevenuePulseExperiment — hourly "is the loop making money?" check.
 *
 * Phase 1 of the money-telos plan. Aggregates the live revenue, pipeline,
 * outreach volume, and burn signals into a single narrative finding
 * every hour. The summary follows the Result / Threshold / Next Move
 * structure so a human or the digest can read one row and know what
 * the loop should push on next to move the revenue needle.
 *
 * Inputs (read-only):
 *   - agent_workforce_revenue_entries.amount_cents  (realized revenue)
 *   - agent_workforce_contacts.status               (pipeline counts)
 *   - agent_workforce_contact_events.event_type     (qualification volume)
 *   - x_dm_messages.direction                        (outreach in/out)
 *   - self_findings[experiment_id='burn-rate']       (latest LLM spend)
 *
 * Output: one self_findings row with subject='pulse:HOUR_KEY' and a
 * narrative summary. The inner boot dedupe keeps restart churn cheap
 * — repeated boots within the same hour emit a skip row.
 *
 * Cadence: every 60 min, runOnBoot: true. Same pattern as
 * daily-surprise-digest — the boot-dedupe guard is the flood-safety.
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

function hourKey(now = new Date()): string {
  const iso = now.toISOString();
  return iso.slice(0, 13); // YYYY-MM-DDTHH
}

interface RevenueRow { amount_cents: number; created_at: string; month: number; year: number }
interface ContactRow { status: string }
interface EventRow { event_type: string; created_at: string }
interface DmRow { direction: string; observed_at: string }
interface BurnEv { total_cents_today?: number; delta_cents?: number }

export interface RevenuePulseEvidence extends Record<string, unknown> {
  hour: string;
  revenue_cents_24h: number;
  revenue_cents_7d: number;
  revenue_cents_mtd: number;
  outbound_dm_24h: number;
  inbound_dm_24h: number;
  reply_ratio: number | null;
  qualified_events_24h: number;
  qualified_events_7d: number;
  active_leads: number;
  active_customers: number;
  burn_cents_today: number;
  signal_spend_ratio: number | null;
  next_move: string;
}

export class RevenuePulseExperiment implements Experiment {
  readonly id = 'revenue-pulse';
  readonly name = 'Revenue pulse (hourly money-telos check)';
  readonly category: ExperimentCategory = 'business_outcome';
  readonly hypothesis =
    'The autonomous loop should move the revenue needle. An hourly aggregate of realized revenue, outreach volume, pipeline stage, and LLM burn gives the loop (and the operator) one place to see whether that is actually happening, and a Next Move pointer for what to try next.';
  readonly cadence = CADENCE;

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const now = new Date();
    const hk = hourKey(now);

    const prior = await listFindings(ctx.db, { experimentId: this.id, limit: 1 });
    if (prior[0]?.ranAt && hourKey(new Date(prior[0].ranAt)) === hk) {
      return {
        subject: `pulse:${hk}`,
        summary: `Result: pulse already ran this hour at ${prior[0].ranAt}.\nThreshold: one pulse per hour max.\nConclusion: skipped (dedupe); no new signal to emit.`,
        evidence: { hour: hk, skipped: true },
      };
    }

    const nowMs = now.getTime();
    const since7d = new Date(nowMs - WEEK_MS).toISOString();
    const since24h = new Date(nowMs - DAY_MS).toISOString();

    const [rev, contacts, events, dms, burn] = await Promise.all([
      this.readRevenue(ctx, since7d),
      this.readContacts(ctx),
      this.readEvents(ctx, since7d),
      this.readDms(ctx, since24h),
      this.readLatestBurn(ctx),
    ]);

    let rev24 = 0, rev7 = 0, revMtd = 0;
    for (const r of rev) {
      const cents = Number(r.amount_cents) || 0;
      rev7 += cents;
      const ts = new Date(r.created_at).getTime();
      if (!Number.isNaN(ts) && nowMs - ts <= DAY_MS) rev24 += cents;
      if (r.year === now.getUTCFullYear() && r.month === now.getUTCMonth() + 1) revMtd += cents;
    }

    let outbound = 0, inbound = 0;
    for (const d of dms) {
      if (d.direction === 'outbound') outbound += 1;
      else if (d.direction === 'inbound') inbound += 1;
    }
    const replyRatio = outbound > 0 ? inbound / outbound : null;

    let qualified24 = 0, qualified7 = 0;
    for (const e of events) {
      if (!e.event_type?.startsWith('x:qualified')) continue;
      qualified7 += 1;
      const ts = new Date(e.created_at).getTime();
      if (!Number.isNaN(ts) && nowMs - ts <= DAY_MS) qualified24 += 1;
    }

    let activeLeads = 0, activeCustomers = 0;
    for (const c of contacts) {
      if (c.status === 'active') activeLeads += 1;
      if (c.status === 'customer') activeCustomers += 1;
    }

    const burnCents = Number(burn?.total_cents_today ?? 0);
    const signalSpend = burnCents > 0 ? rev24 / burnCents : null;
    const nextMove = decideNextMove({ rev24, rev7, outbound, replyRatio, qualified24, activeCustomers, burnCents });

    const evidence: RevenuePulseEvidence = {
      hour: hk,
      revenue_cents_24h: rev24,
      revenue_cents_7d: rev7,
      revenue_cents_mtd: revMtd,
      outbound_dm_24h: outbound,
      inbound_dm_24h: inbound,
      reply_ratio: replyRatio,
      qualified_events_24h: qualified24,
      qualified_events_7d: qualified7,
      active_leads: activeLeads,
      active_customers: activeCustomers,
      burn_cents_today: burnCents,
      signal_spend_ratio: signalSpend,
      next_move: nextMove,
    };

    const summary = [
      `Result: $${(rev24 / 100).toFixed(2)} revenue in last 24h, $${(rev7 / 100).toFixed(2)} in 7d. Outreach: ${outbound} outbound / ${inbound} inbound DM (reply_ratio=${replyRatio === null ? 'n/a' : replyRatio.toFixed(2)}). Pipeline: ${activeLeads} active lead(s), ${activeCustomers} customer(s). Burn today: $${(burnCents / 100).toFixed(2)}.`,
      'Threshold: fail if 7d revenue = $0 and burn > $0 and outbound_dm_24h < 3 (unprofitable, under-dispatching). Warn if 7d revenue < burn_today (underwater).',
      `Next Move: ${nextMove}`,
    ].join('\n');

    return { subject: `pulse:${hk}`, summary, evidence };
  }

  judge(result: ProbeResult, _h: Finding[]): Verdict {
    const ev = result.evidence as RevenuePulseEvidence & { skipped?: boolean };
    if (ev.skipped) return 'pass';
    if (ev.revenue_cents_7d === 0 && ev.burn_cents_today > 0 && ev.outbound_dm_24h < 3) return 'fail';
    if (ev.revenue_cents_7d < ev.burn_cents_today) return 'warning';
    return 'pass';
  }

  private async readRevenue(ctx: ExperimentContext, since: string): Promise<RevenueRow[]> {
    try {
      const { data } = await ctx.db
        .from<RevenueRow>('agent_workforce_revenue_entries')
        .select('amount_cents,created_at,month,year')
        .eq('workspace_id', ctx.workspaceId)
        .gte('created_at', since)
        .limit(5000);
      return (data ?? []) as RevenueRow[];
    } catch { return []; }
  }

  private async readContacts(ctx: ExperimentContext): Promise<ContactRow[]> {
    try {
      const { data } = await ctx.db
        .from<ContactRow>('agent_workforce_contacts')
        .select('status')
        .eq('workspace_id', ctx.workspaceId)
        .limit(5000);
      return (data ?? []) as ContactRow[];
    } catch { return []; }
  }

  private async readEvents(ctx: ExperimentContext, since: string): Promise<EventRow[]> {
    try {
      const { data } = await ctx.db
        .from<EventRow>('agent_workforce_contact_events')
        .select('event_type,created_at')
        .eq('workspace_id', ctx.workspaceId)
        .gte('created_at', since)
        .limit(5000);
      return (data ?? []) as EventRow[];
    } catch { return []; }
  }

  private async readDms(ctx: ExperimentContext, since: string): Promise<DmRow[]> {
    try {
      const { data } = await ctx.db
        .from<DmRow>('x_dm_messages')
        .select('direction,observed_at')
        .eq('workspace_id', ctx.workspaceId)
        .gte('observed_at', since)
        .limit(5000);
      return (data ?? []) as DmRow[];
    } catch { return []; }
  }

  private async readLatestBurn(ctx: ExperimentContext): Promise<BurnEv | null> {
    try {
      const prior = await listFindings(ctx.db, { experimentId: 'burn-rate', limit: 1 });
      const ev = prior[0]?.evidence;
      return ev && typeof ev === 'object' ? (ev as BurnEv) : null;
    } catch { return null; }
  }
}

interface Signals {
  rev24: number; rev7: number; outbound: number; replyRatio: number | null;
  qualified24: number; activeCustomers: number; burnCents: number;
}

export function decideNextMove(s: Signals): string {
  if (s.activeCustomers === 0 && s.rev7 === 0 && s.outbound < 3) {
    return 'zero customers, zero revenue, under-dispatching outreach. Highest-leverage move: raise outbound DM volume — the sales loop needs reps before it can learn what converts.';
  }
  if (s.rev7 === 0 && s.qualified24 === 0) {
    return 'no qualified events in 24h and no 7d revenue. Highest-leverage move: audit the qualifier (x-authors-to-crm classifier) — either the intake is empty or the classifier is filtering too aggressively.';
  }
  if (s.rev7 === 0 && s.replyRatio !== null && s.replyRatio < 0.1) {
    return `outreach is firing but replies are rare (ratio=${s.replyRatio.toFixed(2)}). Highest-leverage move: rewrite the outreach-thermostat copy — current template is not landing.`;
  }
  if (s.burnCents > 0 && s.rev7 < s.burnCents) {
    return `underwater: burned $${(s.burnCents / 100).toFixed(2)} today, 7d revenue $${(s.rev7 / 100).toFixed(2)}. Highest-leverage move: cap spend on non-revenue-adjacent experiments (experiment-cost-observer ranks them) while the sales loop catches up.`;
  }
  if (s.rev7 > 0 && s.activeCustomers > 0) {
    return `revenue flowing ($${(s.rev7 / 100).toFixed(2)} in 7d, ${s.activeCustomers} customer(s)). Highest-leverage move: double down on whichever outreach template the latest conversions came from — check outreach-thermostat evidence for the winner.`;
  }
  return 'signal mixed; no obvious single lever. Read the evidence numbers directly and decide manually.';
}
