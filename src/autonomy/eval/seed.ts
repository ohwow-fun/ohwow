/**
 * Translate a declarative `SeedSpec` into INSERTs against the workspace
 * SQLite tables. Mirrors the production pulse reader's column shapes
 * (`src/api/routes/pulse.ts` + `src/autonomy/pulse.ts`) so the ranker
 * sees the same data shape it would in prod.
 *
 * Each seed family is its own helper so a missing or schema-shifted
 * table fails loudly with the table name. We never invent columns: if
 * the production migration calls a column `value_cents`, the seed
 * writes `value_cents`, not a stand-in.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type {
  ScenarioContext,
  SeedApproval,
  SeedDeal,
  SeedFailingTrigger,
  SeedFinding,
  SeedFounderInbox,
  SeedPriorPhaseReport,
  SeedQualifiedContact,
  SeedSpec,
} from './types.js';

function isoMinus(now: Date, hoursAgo: number): string {
  return new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
}

function isoMinusDays(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
}

async function insertOrThrow(
  db: DatabaseAdapter,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from(table).insert(row);
  if (error) {
    throw new Error(`seed.${table}: ${error.message}`);
  }
}

// ---- per-family helpers -------------------------------------------------

async function seedApprovals(
  ctx: ScenarioContext,
  rows: SeedApproval[],
): Promise<void> {
  // approvals_pending in pulse.ts reads `agent_workforce_tasks` rows with
  // status='needs_approval'. Mirror exactly that shape.
  const now = ctx.now();
  for (const r of rows) {
    const id = r.id ?? ctx.nextId('ap');
    await insertOrThrow(ctx.db, 'agent_workforce_tasks', {
      id,
      workspace_id: ctx.workspace_id,
      agent_id: 'eval-agent',
      title: r.subject,
      description: r.subject,
      status: 'needs_approval',
      priority: 'normal',
      requires_approval: 1,
      created_at: isoMinus(now, r.age_hours),
      updated_at: isoMinus(now, r.age_hours),
    });
  }
}

async function seedDeals(
  ctx: ScenarioContext,
  rows: SeedDeal[],
): Promise<void> {
  // pulse.ts.readRottingDeals consults `deals` and uses
  // updated_at ?? created_at to compute idle_days; filter excludes any
  // stage matching /closed/i.
  const now = ctx.now();
  for (const r of rows) {
    const id = r.id ?? ctx.nextId('deal');
    const updatedAt = isoMinusDays(now, r.idle_days);
    await insertOrThrow(ctx.db, 'deals', {
      id,
      workspace_id: ctx.workspace_id,
      title: `eval deal ${id}`,
      stage_name: r.stage,
      stage_id: null,
      value_cents: r.expected_value_cents ?? 0,
      currency: 'USD',
      created_at: updatedAt,
      updated_at: updatedAt,
    });
  }
}

async function seedQualifiedContacts(
  ctx: ScenarioContext,
  rows: SeedQualifiedContact[],
): Promise<void> {
  // pulse.ts.readQualifiedNoOutreach pulls contacts with an x:qualified
  // event and no recent outbound DM. We seed the contact + the event;
  // we deliberately do NOT seed any outbound DM, so the contact stays
  // in "no outreach" territory.
  const now = ctx.now();
  for (const r of rows) {
    const id = r.id ?? ctx.nextId('contact');
    await insertOrThrow(ctx.db, 'agent_workforce_contacts', {
      id,
      workspace_id: ctx.workspace_id,
      name: r.name ?? `Eval Contact ${id}`,
      contact_type: 'lead',
      status: 'active',
    });
    const eventId = ctx.nextId('event');
    await insertOrThrow(ctx.db, 'agent_workforce_contact_events', {
      id: eventId,
      workspace_id: ctx.workspace_id,
      contact_id: id,
      event_type: 'x:qualified',
      title: 'Qualified by X intel',
      description: 'eval seed',
      kind: 'x:qualified',
      source: 'eval',
      payload: '{}',
      occurred_at: isoMinus(now, r.qualified_hours_ago),
      created_at: isoMinus(now, r.qualified_hours_ago),
    });
  }
}

async function seedFailingTriggers(
  ctx: ScenarioContext,
  rows: SeedFailingTrigger[],
): Promise<void> {
  // pulse.ts.readFailingTriggers selects from `local_triggers` where
  // consecutive_failures >= 3.
  const now = ctx.now();
  for (const r of rows) {
    const id = r.id ?? ctx.nextId('trig');
    await insertOrThrow(ctx.db, 'local_triggers', {
      id,
      name: r.class,
      description: `eval trigger ${id}`,
      enabled: 1,
      source: 'eval',
      event_type: r.class,
      // pulse.ts uses `trigger_type ?? name` for the class label;
      // migration 021 added trigger_type with default 'webhook' so we
      // must override it here for the class to match what the
      // scenarios expect.
      trigger_type: r.class,
      conditions: '{}',
      action_type: 'run_agent',
      action_config: '{}',
      cooldown_seconds: 60,
      last_fired_at: isoMinus(now, r.last_failure_hours_ago),
      consecutive_failures: r.failure_count,
      fire_count: r.failure_count,
    });
  }
}

async function seedFindings(
  ctx: ScenarioContext,
  rows: SeedFinding[],
): Promise<void> {
  // pulse.ts.readDashboardSmokeRed and readRecentFindingClasses both
  // read `self_findings` filtered to verdict='fail' inside the recent
  // lookback window.
  const now = ctx.now();
  for (const r of rows) {
    const id = r.id ?? ctx.nextId('find');
    const ts = isoMinus(now, r.hours_ago);
    await insertOrThrow(ctx.db, 'self_findings', {
      id,
      experiment_id: 'eval',
      category: r.category,
      subject: r.subject ?? r.category,
      verdict: r.verdict,
      summary: `eval finding ${id}`,
      evidence: '{}',
      ran_at: ts,
      duration_ms: 0,
      status: 'active',
      created_at: ts,
    });
  }
}

async function seedBusinessVitals(
  ctx: ScenarioContext,
  v: NonNullable<SeedSpec['business_vitals']>,
): Promise<void> {
  // pulse.ts.readBusinessVitals takes the most recent row per workspace
  // (ts DESC LIMIT 1). We append a fresh row keyed to the current fake
  // clock so subsequent seed rounds (mid-scenario) supersede the old.
  await insertOrThrow(ctx.db, 'business_vitals', {
    id: ctx.nextId('vital'),
    workspace_id: ctx.workspace_id,
    ts: ctx.now().toISOString(),
    mrr: v.mrr_cents,
    arr: v.mrr_cents !== undefined ? v.mrr_cents * 12 : null,
    active_users: null,
    daily_cost_cents: v.daily_llm_cost_cents,
    runway_days: null,
    source: 'eval',
    created_at: ctx.now().toISOString(),
  });
}

async function seedFounderInbox(
  ctx: ScenarioContext,
  rows: SeedFounderInbox[],
): Promise<void> {
  const now = ctx.now();
  for (const r of rows) {
    const id = r.id ?? ctx.nextId('fi');
    const askedIso = isoMinus(now, r.asked_hours_ago);
    const isAnswered = r.status === 'answered' || r.status === 'resolved';
    await insertOrThrow(ctx.db, 'founder_inbox', {
      id,
      workspace_id: ctx.workspace_id,
      arc_id: r.arc_id ?? null,
      phase_id: r.phase_id ?? null,
      mode: r.mode,
      blocker: r.blocker,
      context: r.blocker,
      options_json: '[]',
      recommended: null,
      screenshot_path: null,
      asked_at: askedIso,
      answered_at: isAnswered ? askedIso : null,
      answer: r.answer ?? null,
      status: r.status,
    });
  }
}

async function seedPriorPhaseReports(
  ctx: ScenarioContext,
  rows: SeedPriorPhaseReport[],
): Promise<void> {
  // The ranker reads recent `director_phase_reports` to compute novelty,
  // cadence, and regression penalties. Each row needs a parent
  // `director_arcs` row (FK constraint). We synthesise an arc per unique
  // arc_id requested. The arc is `closed` by default; rows can set
  // `parent_arc_open` to keep the synthetic arc OPEN (used by the
  // Phase 6.7 restart-mid-arc scenario).
  const now = ctx.now();
  const arcsCreated = new Map<string, { open: boolean }>();
  for (const r of rows) {
    const arcId = r.arc_id ?? ctx.nextId('priorarc');
    const want_open = r.parent_arc_open === true;
    const existing = arcsCreated.get(arcId);
    if (existing && existing.open !== want_open) {
      throw new Error(
        `seed.prior_phase_reports: conflicting parent_arc_open for arc ${arcId}`,
      );
    }
    if (!existing) {
      const startedIso = isoMinus(now, r.hours_ago);
      await insertOrThrow(ctx.db, 'director_arcs', {
        id: arcId,
        workspace_id: ctx.workspace_id,
        opened_at: startedIso,
        closed_at: want_open ? null : startedIso,
        mode_of_invocation: 'loop-tick',
        thesis: 'eval prior arc',
        status: want_open ? 'open' : 'closed',
        budget_max_phases: 6,
        budget_max_minutes: 240,
        budget_max_inbox_qs: 3,
        kill_on_pulse_regression: 1,
        pulse_at_entry_json: '{}',
        pulse_at_close_json: want_open ? null : '{}',
        exit_reason: want_open ? null : 'nothing-queued',
      });
      arcsCreated.set(arcId, { open: want_open });
    }
    const reportId = r.id ?? ctx.nextId('priorpr');
    const startedIso = isoMinus(now, r.hours_ago);
    await insertOrThrow(ctx.db, 'director_phase_reports', {
      id: reportId,
      arc_id: arcId,
      workspace_id: ctx.workspace_id,
      phase_id: r.phase_id ?? `${reportId}_logical`,
      mode: r.mode,
      goal: r.goal_source,
      status: r.status,
      trios_run: 1,
      runtime_sha_start: null,
      runtime_sha_end: null,
      cloud_sha_start: null,
      cloud_sha_end: null,
      delta_pulse_json: null,
      delta_ledger_json: 'eval prior',
      inbox_added_json: '0',
      remaining_scope: null,
      next_phase_recommendation: null,
      cost_trios: 1,
      cost_minutes: 1,
      cost_llm_cents: 0,
      raw_report: 'eval prior report',
      started_at: startedIso,
      ended_at: startedIso,
    });
  }
}

// ---- public --------------------------------------------------------------

export async function applySeed(
  ctx: ScenarioContext,
  spec: SeedSpec,
): Promise<void> {
  if (spec.approvals?.length) await seedApprovals(ctx, spec.approvals);
  if (spec.deals?.length) await seedDeals(ctx, spec.deals);
  if (spec.contacts_qualified?.length)
    await seedQualifiedContacts(ctx, spec.contacts_qualified);
  if (spec.failing_triggers?.length)
    await seedFailingTriggers(ctx, spec.failing_triggers);
  if (spec.findings?.length) await seedFindings(ctx, spec.findings);
  if (spec.business_vitals)
    await seedBusinessVitals(ctx, spec.business_vitals);
  if (spec.founder_inbox?.length)
    await seedFounderInbox(ctx, spec.founder_inbox);
  if (spec.prior_phase_reports?.length)
    await seedPriorPhaseReports(ctx, spec.prior_phase_reports);
}

/** Compact one-line summary of a seed for the transcript header. */
export function summarizeSeed(spec: SeedSpec): string {
  const parts: string[] = [];
  if (spec.approvals?.length) parts.push(`approvals=${spec.approvals.length}`);
  if (spec.deals?.length) parts.push(`deals=${spec.deals.length}`);
  if (spec.contacts_qualified?.length)
    parts.push(`qualified=${spec.contacts_qualified.length}`);
  if (spec.failing_triggers?.length)
    parts.push(`failing_triggers=${spec.failing_triggers.length}`);
  if (spec.findings?.length) parts.push(`findings=${spec.findings.length}`);
  if (spec.business_vitals) {
    const bits: string[] = [];
    const v = spec.business_vitals;
    if (v.mrr_cents !== undefined) bits.push(`mrr=${v.mrr_cents}`);
    if (v.pipeline_count !== undefined) bits.push(`pipeline=${v.pipeline_count}`);
    if (v.daily_llm_cost_cents !== undefined)
      bits.push(`llm_cost=${v.daily_llm_cost_cents}`);
    if (v.pending_approvals_count !== undefined)
      bits.push(`pending_approvals=${v.pending_approvals_count}`);
    if (bits.length) parts.push(`vitals(${bits.join(',')})`);
  }
  if (spec.founder_inbox?.length)
    parts.push(`inbox=${spec.founder_inbox.length}`);
  if (spec.prior_phase_reports?.length)
    parts.push(`prior_reports=${spec.prior_phase_reports.length}`);
  return parts.length === 0 ? 'empty' : parts.join('; ');
}
