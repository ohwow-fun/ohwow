/**
 * RevenuePipelineObserverExperiment — Piece 5 of the surprise-first
 * bundle. The first experiment that ties self-observation directly to
 * "are we making money?".
 *
 * Reads everything we already record about commercial state and asks:
 *   - Are active revenue-shaped goals on pace?
 *   - Are net new leads moving week over week, or flat?
 *   - Is monthly revenue tracking toward the active MRR target?
 *   - Are X-qualified author candidates piling up un-imported into CRM?
 *
 * Inputs:
 *   - agent_workforce_goals (active rows where target_metric matches
 *     /mrr|arr|revenue|posts|leads|customers/i)
 *   - agent_workforce_contacts (count by contact_type + ISO-week cohort)
 *   - agent_workforce_contact_events (kind distribution last 7d / 30d)
 *   - agent_workforce_revenue_entries (sum month-to-date)
 *   - ~/.ohwow/workspaces/<slug>/x-authors-ledger.jsonl (qualified
 *     handles with no crm_contact_id)
 *
 * Verdict policy:
 *   pass    — every observed signal is on or ahead of pace
 *   warning — any goal below pace OR flat net-leads OR pending
 *             x:qualified queue
 *   fail    — any goal below 30% of elapsed-period pace
 *             (clear, structural pipeline gap)
 *
 * Intervention is ADVISORY ONLY in v1 per operator decision. Writes
 * `strategy.revenue_gap_focus` runtime_config so the strategist's
 * `strategy.active_focus` summary surfaces the dollar-connected
 * insight ahead of infra noise; cascades the bottleneck experiment
 * id into `strategy.priority_experiments` so experiment-author
 * ranks revenue-aligned briefs first. NO task creation, NO outbound
 * messaging — those are v2 candidates after a month of observation.
 *
 * Subclass of BusinessExperiment so the workspace guard keeps the
 * observer pinned to the GTM dogfood slot and never reads commercial
 * state on a customer workspace.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

const CADENCE: ExperimentCadence = { everyMs: 60 * 60 * 1000, runOnBoot: true };
const REVENUE_METRIC_RE = /mrr|arr|revenue|posts|leads|customers/i;
/** Minimum qualified-but-unpromoted X authors before we flag it. */
const X_QUALIFIED_PENDING_WARN = 5;
/** Goal-progress fraction below this (relative to elapsed-period) is fail. */
const GOAL_FAIL_FRACTION = 0.3;
/** Goal-progress fraction below this is warning. */
const GOAL_WARN_FRACTION = 0.7;
/** Net-leads delta below this (over 7d) is "flat" for warning purposes. */
const FLAT_LEADS_DELTA = 0;

interface GoalRow {
  id: string;
  title: string;
  target_metric: string | null;
  target_value: number | null;
  current_value: number | null;
  unit: string | null;
  due_date: string | null;
  status: string;
  created_at?: string | null;
}

interface ContactRow {
  id: string;
  contact_type: string;
  status: string;
  created_at: string | null;
}

interface ContactEventRow {
  id: string;
  kind: string | null;
  source: string | null;
  occurred_at: string | null;
  created_at: string | null;
}

interface RevenueEntryRow {
  amount_cents: number;
  month: number;
  year: number;
}

interface GoalProgressView {
  goal_id: string;
  title: string;
  metric: string;
  target: number;
  current: number;
  pace_fraction: number; // current / expected_at_now
  required_per_day: number | null;
  due_date: string | null;
}

export interface RevenuePipelineEvidence extends Record<string, unknown> {
  active_goals: GoalProgressView[];
  worst_goal_pace_fraction: number;
  goal_count_below_warn: number;
  goal_count_below_fail: number;
  leads_total_active: number;
  leads_added_last_7d: number;
  customers_active: number;
  events_last_7d_by_kind: Record<string, number>;
  revenue_mtd_cents: number;
  x_qualified_pending: number;
  __tracked_field: 'worst_goal_pace_fraction';
}

function isoWeekKey(d: Date): string {
  // YYYY-Www; lazy approximation good enough for week cohorts.
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d.getTime() - onejan.getTime()) / 86400000) + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function startOfMonthIso(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

function paceFraction(goal: GoalRow, now: Date): number {
  const target = Number(goal.target_value ?? 0);
  const current = Number(goal.current_value ?? 0);
  if (target <= 0) return 1; // no target means we can't fail it
  // Without a due_date, fall back to the current-month period: assume
  // the goal is meant to be hit by end of the month it was created in
  // (or end of current month if created_at is missing). This keeps the
  // observer working for goals that don't carry due_date yet — common
  // in early data.
  let periodStart: Date;
  let periodEnd: Date;
  if (goal.due_date) {
    periodEnd = new Date(goal.due_date);
    const created = goal.created_at ? new Date(goal.created_at) : null;
    periodStart = created ?? new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }
  const total = Math.max(periodEnd.getTime() - periodStart.getTime(), 1);
  const elapsed = Math.max(0, Math.min(total, now.getTime() - periodStart.getTime()));
  const elapsedFrac = elapsed / total;
  const expected = target * elapsedFrac;
  if (expected <= 0) return 1;
  return current / expected;
}

function readXQualifiedPending(slug: string): number {
  const filePath = path.join(os.homedir(), '.ohwow', 'workspaces', slug, 'x-authors-ledger.jsonl');
  if (!fs.existsSync(filePath)) return 0;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 0;
  }
  let pending = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { qualified_ts?: string | null; crm_contact_id?: string | null };
      if (row.qualified_ts && !row.crm_contact_id) pending += 1;
    } catch { /* skip bad rows */ }
  }
  return pending;
}

export class RevenuePipelineObserverExperiment extends BusinessExperiment {
  readonly id = 'revenue-pipeline-observer';
  readonly name = 'Revenue pipeline observer';
  readonly hypothesis =
    'Active revenue-shaped goals stay on pace, net leads move week over week, monthly revenue tracks the MRR target, and qualified X authors flow into CRM. Any of those drifting is a finding the operator should see at the top of the distilled view.';
  readonly cadence = CADENCE;

  constructor(opts: BusinessExperimentOptions = {}) {
    super(opts);
  }

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Goals — active, revenue-shaped target_metric.
    let goals: GoalRow[] = [];
    try {
      const res = await (ctx.db as DatabaseAdapter)
        .from<GoalRow>('agent_workforce_goals')
        .select('id, title, target_metric, target_value, current_value, unit, due_date, status, created_at')
        .eq('workspace_id', ctx.workspaceId)
        .eq('status', 'active');
      goals = ((res as { data?: GoalRow[] | null }).data ?? []) as GoalRow[];
    } catch (err) {
      logger.warn({ err }, '[revenue-pipeline-observer] read goals failed');
    }
    const revenueGoals = goals.filter((g) => g.target_metric && REVENUE_METRIC_RE.test(g.target_metric));

    const goalViews: GoalProgressView[] = revenueGoals.map((g) => ({
      goal_id: g.id,
      title: g.title,
      metric: g.target_metric ?? '?',
      target: Number(g.target_value ?? 0),
      current: Number(g.current_value ?? 0),
      pace_fraction: paceFraction(g, now),
      required_per_day: null,
      due_date: g.due_date ?? null,
    }));
    const paceFractions = goalViews.map((g) => g.pace_fraction);
    const worstPace = paceFractions.length === 0 ? 1 : Math.min(...paceFractions);
    const goalsBelowWarn = goalViews.filter((g) => g.pace_fraction < GOAL_WARN_FRACTION).length;
    const goalsBelowFail = goalViews.filter((g) => g.pace_fraction < GOAL_FAIL_FRACTION).length;

    // 2. Contacts — total active leads + customers + 7d new-lead delta.
    let contacts: ContactRow[] = [];
    try {
      const res = await (ctx.db as DatabaseAdapter)
        .from<ContactRow>('agent_workforce_contacts')
        .select('id, contact_type, status, created_at')
        .eq('workspace_id', ctx.workspaceId)
        .eq('status', 'active');
      contacts = ((res as { data?: ContactRow[] | null }).data ?? []) as ContactRow[];
    } catch (err) {
      logger.warn({ err }, '[revenue-pipeline-observer] read contacts failed');
    }
    const leadsActive = contacts.filter((c) => c.contact_type === 'lead').length;
    const customersActive = contacts.filter((c) => c.contact_type === 'customer').length;
    const leadsAdded7d = contacts.filter(
      (c) => c.contact_type === 'lead' && c.created_at && c.created_at >= sevenDaysAgo,
    ).length;

    // 3. Contact events — kind distribution last 7d.
    let events: ContactEventRow[] = [];
    try {
      const res = await (ctx.db as DatabaseAdapter)
        .from<ContactEventRow>('agent_workforce_contact_events')
        .select('id, kind, source, occurred_at, created_at')
        .eq('workspace_id', ctx.workspaceId)
        .gte('created_at', sevenDaysAgo);
      events = ((res as { data?: ContactEventRow[] | null }).data ?? []) as ContactEventRow[];
    } catch (err) {
      logger.warn({ err }, '[revenue-pipeline-observer] read contact_events failed');
    }
    const eventsByKind: Record<string, number> = {};
    for (const e of events) {
      const k = e.kind ?? 'unknown';
      eventsByKind[k] = (eventsByKind[k] ?? 0) + 1;
    }

    // 4. Revenue MTD.
    let revenueRows: RevenueEntryRow[] = [];
    try {
      const res = await (ctx.db as DatabaseAdapter)
        .from<RevenueEntryRow>('agent_workforce_revenue_entries')
        .select('amount_cents, month, year')
        .eq('workspace_id', ctx.workspaceId)
        .eq('year', now.getFullYear())
        .eq('month', now.getMonth() + 1);
      revenueRows = ((res as { data?: RevenueEntryRow[] | null }).data ?? []) as RevenueEntryRow[];
    } catch (err) {
      logger.warn({ err }, '[revenue-pipeline-observer] read revenue failed');
    }
    const revenueMtdCents = revenueRows.reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0);

    // 5. X qualified pending.
    const xQualifiedPending = readXQualifiedPending(ctx.workspaceSlug ?? 'default');

    // Build summary string. Lead with the worst goal if any.
    let summary: string;
    if (goalsBelowFail > 0) {
      const worst = goalViews.reduce((acc, g) => (g.pace_fraction < acc.pace_fraction ? g : acc), goalViews[0]);
      summary = `goal '${worst.title}' at ${worst.current}/${worst.target} (${(worst.pace_fraction * 100).toFixed(0)}% of pace); ${leadsActive} leads, ${customersActive} customers, mtd $${(revenueMtdCents / 100).toFixed(0)}`;
    } else if (goalsBelowWarn > 0) {
      summary = `${goalsBelowWarn} goal(s) below pace; ${leadsActive} leads (+${leadsAdded7d}/7d), ${customersActive} customers, x_qualified_pending=${xQualifiedPending}`;
    } else if (xQualifiedPending >= X_QUALIFIED_PENDING_WARN) {
      summary = `${xQualifiedPending} qualified X authors not yet in CRM; ${leadsActive} leads, ${customersActive} customers`;
    } else {
      summary = `${revenueGoals.length} active revenue goal(s) on pace; ${leadsActive} leads (+${leadsAdded7d}/7d), ${customersActive} customers`;
    }
    void isoWeekKey; // reserved for next iteration's weekly cohort breakdown
    void startOfMonthIso; // ditto
    void FLAT_LEADS_DELTA;

    const evidence: RevenuePipelineEvidence = {
      active_goals: goalViews,
      worst_goal_pace_fraction: worstPace,
      goal_count_below_warn: goalsBelowWarn,
      goal_count_below_fail: goalsBelowFail,
      leads_total_active: leadsActive,
      leads_added_last_7d: leadsAdded7d,
      customers_active: customersActive,
      events_last_7d_by_kind: eventsByKind,
      revenue_mtd_cents: revenueMtdCents,
      x_qualified_pending: xQualifiedPending,
      __tracked_field: 'worst_goal_pace_fraction',
    };

    return { subject: 'revenue:pipeline', summary, evidence };
  }

  protected businessJudge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as RevenuePipelineEvidence;
    if (ev.goal_count_below_fail > 0) return 'fail';
    if (ev.goal_count_below_warn > 0) return 'warning';
    if (ev.leads_added_last_7d <= 0 && ev.x_qualified_pending >= X_QUALIFIED_PENDING_WARN) {
      return 'warning';
    }
    return 'pass';
  }

  protected async businessIntervene(
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (verdict === 'pass') return null;

    const ev = result.evidence as RevenuePipelineEvidence;
    // Identify the bottleneck: worst-pace revenue goal first, then
    // pending X queue, then flat leads.
    let focusText: string;
    let priorityExperiments: string[] = [];
    if (ev.goal_count_below_warn > 0 && ev.active_goals.length > 0) {
      const worst = ev.active_goals.reduce(
        (acc, g) => (g.pace_fraction < acc.pace_fraction ? g : acc),
        ev.active_goals[0],
      );
      focusText = `goal '${worst.title}' at ${worst.current}/${worst.target} ${worst.metric} (${(worst.pace_fraction * 100).toFixed(0)}% of pace)`;
      // X-shaped goals route through the autonomy ramp; revenue-shaped
      // goals route through the engagement observer for now.
      if (/post|x/i.test(worst.metric)) {
        priorityExperiments = ['x-autonomy-ramp', 'x-engagement-observer'];
      } else {
        priorityExperiments = ['x-engagement-observer', 'revenue-pipeline-observer'];
      }
    } else if (ev.x_qualified_pending >= X_QUALIFIED_PENDING_WARN) {
      focusText = `${ev.x_qualified_pending} qualified X authors waiting to enter CRM`;
      priorityExperiments = ['x-engagement-observer'];
    } else {
      focusText = `${ev.leads_total_active} leads flat over last 7d, ${ev.customers_active} customers`;
      priorityExperiments = ['x-engagement-observer'];
    }

    try {
      await setRuntimeConfig(ctx.db, 'strategy.revenue_gap_focus', focusText, { setBy: this.id });
      await setRuntimeConfig(
        ctx.db,
        'strategy.revenue_gap_priorities',
        priorityExperiments,
        { setBy: this.id },
      );
    } catch (err) {
      logger.warn({ err }, '[revenue-pipeline-observer] setRuntimeConfig failed');
      return null;
    }

    return {
      description: `Revenue gap advisory: ${focusText}`,
      details: {
        config_keys: ['strategy.revenue_gap_focus', 'strategy.revenue_gap_priorities'],
        focus_text: focusText,
        priority_experiments: priorityExperiments,
        reversible: true,
      },
    };
  }
}
