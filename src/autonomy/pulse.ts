/**
 * Conductor pulse reader (Phase 5).
 *
 * Aggregates the per-mode signals the ranker scores against. Mirrors the
 * spec's "Conductor ranking" pseudo-code inputs but keeps every subquery
 * permissive: missing tables, malformed rows, NULL columns -> empty
 * arrays / undefined fields, never throws. Designed for sub-200ms
 * execution against the in-memory test DB.
 *
 * The full HTTP pulse aggregator at `src/api/routes/pulse.ts` covers a
 * superset of these signals for the dashboard; this reader is the
 * trimmed surface the Conductor needs at every tick. Keeping it
 * separate avoids dragging the Express-only DB.prepare path (and the
 * approvals JSONL reader, log-tail watcher, etc.) into the autonomy
 * stack.
 */
import { logger } from '../lib/logger.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';

export interface PulseApprovalRef {
  id: string;
  mode: 'revenue';
  age_hours: number;
  subject: string;
}

export interface PulseRottingDeal {
  id: string;
  idle_days: number;
  stage: string;
  expected_value_cents?: number;
}

export interface PulseQualifiedNoOutreach {
  id: string;
  name?: string;
  qualified_at: string;
}

export interface PulseDashboardRed {
  surface: string;
  failure_class: string;
  observed_at: string;
}

export interface PulseFailingTrigger {
  id: string;
  class: string;
  failure_count: number;
  last_failure_at: string;
}

export interface PulseToolingFriction {
  name: string;
  count: number;
}

export interface FullPulseSnapshot {
  ts: string;
  // Core signals (mirror PulseSnapshot from director-persistence.ts)
  mrr_cents?: number;
  pipeline_count?: number;

  // Revenue lens signals
  approvals_pending: PulseApprovalRef[];
  deals_rotting: PulseRottingDeal[];
  qualified_no_outreach: PulseQualifiedNoOutreach[];

  // Polish lens signals
  dashboard_smoke_red: PulseDashboardRed[];

  // Plumbing lens signals
  failing_triggers: PulseFailingTrigger[];
  /** Categories with `verdict='fail'` rows in the recent ledger. */
  recent_finding_classes: string[];

  // Tooling lens signals
  tooling_friction_count_ge_2: PulseToolingFriction[];

  // Health
  daily_llm_cost_cents?: number;
  pending_approvals_count?: number;
}

const FAILING_TRIGGER_THRESHOLD = 3;
const ROTTING_DEAL_IDLE_DAYS = 7;
const NO_OUTREACH_WINDOW_DAYS = 14;
const RECENT_FINDING_LOOKBACK_HOURS = 24;
const RECENT_DASHBOARD_LOOKBACK_HOURS = 24;

function hoursBetween(then: string, now: number): number {
  const t = Date.parse(then.includes('T') ? then : then.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now - t) / (1000 * 60 * 60));
}

function daysBetween(then: string, now: number): number {
  return hoursBetween(then, now) / 24;
}

// ---- per-section readers (each catches its own errors) ------------------

interface TaskRow {
  id: string;
  title: string | null;
  description: string | null;
  created_at: string;
  status: string;
  approval_reason: string | null;
}

async function readApprovalsPending(
  db: DatabaseAdapter,
  workspace_id: string,
  now: number,
): Promise<{ rows: PulseApprovalRef[]; count: number }> {
  try {
    const { data, error } = await db
      .from<TaskRow>('agent_workforce_tasks')
      .select('id, title, description, created_at, status, approval_reason')
      .eq('workspace_id', workspace_id)
      .eq('status', 'needs_approval')
      .is('approval_reason', null)
      .order('created_at', { ascending: true });
    if (error) return { rows: [], count: 0 };
    const rows = (data ?? []).map((r) => ({
      id: r.id,
      mode: 'revenue' as const,
      age_hours: hoursBetween(r.created_at, now),
      subject: (r.title ?? r.description ?? r.id).slice(0, 240),
    }));
    return { rows, count: rows.length };
  } catch (err) {
    logger.warn(
      { workspace_id, err: (err as Error).message },
      'pulse.approvals_pending.failed',
    );
    return { rows: [], count: 0 };
  }
}

interface DealRow {
  id: string;
  stage_name: string | null;
  stage_id: string | null;
  value_cents: number | null;
  updated_at: string | null;
  created_at: string | null;
}

async function readRottingDeals(
  db: DatabaseAdapter,
  workspace_id: string,
  now: number,
): Promise<PulseRottingDeal[]> {
  try {
    const { data, error } = await db
      .from<DealRow>('deals')
      .select('id, stage_name, stage_id, value_cents, updated_at, created_at')
      .eq('workspace_id', workspace_id);
    if (error) return [];
    const out: PulseRottingDeal[] = [];
    for (const r of data ?? []) {
      const ref = r.updated_at ?? r.created_at;
      if (!ref) continue;
      const idle = daysBetween(ref, now);
      if (idle < ROTTING_DEAL_IDLE_DAYS) continue;
      const stage = r.stage_name ?? r.stage_id ?? 'unknown';
      // Filter out closed-won / closed-lost stages by name (best-effort).
      if (/closed/i.test(stage)) continue;
      out.push({
        id: r.id,
        idle_days: Math.floor(idle),
        stage,
        expected_value_cents: r.value_cents ?? undefined,
      });
    }
    // Worst rot first.
    out.sort((a, b) => b.idle_days - a.idle_days);
    return out;
  } catch (err) {
    logger.warn(
      { workspace_id, err: (err as Error).message },
      'pulse.deals_rotting.failed',
    );
    return [];
  }
}

interface QualifiedEventRow {
  contact_id: string;
  occurred_at: string | null;
  created_at: string | null;
  kind: string | null;
}

interface ContactNameRow {
  id: string;
  name: string | null;
}

interface OutreachMessageRow {
  conversation_pair: string;
  observed_at: string | null;
}

interface DmThreadRow {
  contact_id: string | null;
  conversation_pair: string;
}

/**
 * Heuristic: contacts that received an `x:qualified` event but have no
 * outbound DM in the past NO_OUTREACH_WINDOW_DAYS days. We do this in TS
 * (rather than one cross-table SQL join) because the adapter does not
 * expose a raw query path and we want each subquery wrapped in its own
 * try/catch.
 */
async function readQualifiedNoOutreach(
  db: DatabaseAdapter,
  workspace_id: string,
  now: number,
): Promise<PulseQualifiedNoOutreach[]> {
  try {
    const { data: qualifiedRaw } = await db
      .from<QualifiedEventRow>('agent_workforce_contact_events')
      .select('contact_id, occurred_at, created_at, kind')
      .eq('workspace_id', workspace_id)
      .eq('kind', 'x:qualified');
    const qualified = (qualifiedRaw ?? []) as QualifiedEventRow[];
    if (qualified.length === 0) return [];

    // Most recent qualified-at per contact.
    const latestQualified = new Map<string, string>();
    for (const q of qualified) {
      const ts = q.occurred_at ?? q.created_at;
      if (!ts || !q.contact_id) continue;
      const prev = latestQualified.get(q.contact_id);
      if (!prev || ts > prev) latestQualified.set(q.contact_id, ts);
    }
    if (latestQualified.size === 0) return [];

    // Collect all conversation_pairs we have outbound activity on within
    // the window; map back to contact_id via x_dm_threads.
    const cutoffMs = now - NO_OUTREACH_WINDOW_DAYS * 86_400_000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const outboundPairs = new Set<string>();
    try {
      const { data: msgs } = await db
        .from<OutreachMessageRow & { direction: string; workspace_id: string }>(
          'x_dm_messages',
        )
        .select('conversation_pair, observed_at')
        .eq('workspace_id', workspace_id)
        .eq('direction', 'outbound')
        .gte('observed_at', cutoffIso);
      for (const m of msgs ?? []) {
        if (m.conversation_pair) outboundPairs.add(m.conversation_pair);
      }
    } catch {
      /* outbound table may not exist on minimal DBs */
    }

    const recentlyContacted = new Set<string>();
    if (outboundPairs.size > 0) {
      try {
        const { data: threads } = await db
          .from<DmThreadRow>('x_dm_threads')
          .select('contact_id, conversation_pair')
          .eq('workspace_id', workspace_id);
        for (const t of threads ?? []) {
          if (t.contact_id && outboundPairs.has(t.conversation_pair)) {
            recentlyContacted.add(t.contact_id);
          }
        }
      } catch {
        /* threads table missing -> no contacts get filtered */
      }
    }

    const contactIds = Array.from(latestQualified.keys()).filter(
      (cid) => !recentlyContacted.has(cid),
    );
    if (contactIds.length === 0) return [];

    // Hydrate contact names. We pull them in one read (id IN list) when
    // the adapter supports it, otherwise per-id maybeSingle would be too
    // chatty — just leave name undefined.
    const nameById = new Map<string, string | null>();
    try {
      const { data: contacts } = await db
        .from<ContactNameRow>('agent_workforce_contacts')
        .select('id, name')
        .eq('workspace_id', workspace_id)
        .in('id', contactIds);
      for (const c of contacts ?? []) {
        nameById.set(c.id, c.name);
      }
    } catch {
      /* hydrate is best-effort */
    }

    // Filter out deleted contacts: only emit candidates whose id was
    // returned by the contacts hydration query. If the hydration query
    // returned nothing at all (network/table error) fall through
    // unfiltered so we don't silently drop the entire list.
    const liveContactIds =
      nameById.size === 0 && contactIds.length > 0
        ? (logger.warn(
            { workspace_id, count: contactIds.length },
            'pulse.qualified_no_outreach.hydration_empty – emitting unfiltered to avoid silent drop',
          ),
          contactIds)
        : contactIds.filter((cid) => nameById.has(cid));

    return liveContactIds.map((cid) => ({
      id: cid,
      name: nameById.get(cid) ?? undefined,
      qualified_at: latestQualified.get(cid)!,
    }));
  } catch (err) {
    logger.warn(
      { workspace_id, err: (err as Error).message },
      'pulse.qualified_no_outreach.failed',
    );
    return [];
  }
}

interface FindingRow {
  id: string;
  category: string | null;
  subject: string | null;
  verdict: string;
  created_at: string;
  status: string;
}

async function readDashboardSmokeRed(
  db: DatabaseAdapter,
  now: number,
): Promise<PulseDashboardRed[]> {
  try {
    const cutoff = new Date(
      now - RECENT_DASHBOARD_LOOKBACK_HOURS * 3_600_000,
    ).toISOString();
    const { data } = await db
      .from<FindingRow>('self_findings')
      .select('id, category, subject, verdict, created_at, status')
      .eq('verdict', 'fail')
      .gte('created_at', cutoff);
    const out: PulseDashboardRed[] = [];
    for (const r of (data ?? []) as FindingRow[]) {
      if (!r.category) continue;
      if (!/^dashboard-(smoke|copy)$/.test(r.category)) continue;
      out.push({
        surface: r.subject ?? r.category,
        failure_class: r.category,
        observed_at: r.created_at,
      });
    }
    return out;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'pulse.dashboard_smoke_red.failed',
    );
    return [];
  }
}

interface LocalTriggerRow {
  id: string;
  name: string;
  trigger_type: string | null;
  consecutive_failures: number | null;
  last_succeeded_at: string | null;
  last_fired_at: string | null;
  enabled: number;
}

async function readFailingTriggers(
  db: DatabaseAdapter,
): Promise<PulseFailingTrigger[]> {
  try {
    const { data } = await db
      .from<LocalTriggerRow>('local_triggers')
      .select(
        'id, name, trigger_type, consecutive_failures, last_succeeded_at, last_fired_at, enabled',
      )
      .gte('consecutive_failures', FAILING_TRIGGER_THRESHOLD)
      .order('consecutive_failures', { ascending: false });
    return ((data ?? []) as LocalTriggerRow[]).map((r) => ({
      id: r.id,
      class: r.trigger_type ?? r.name,
      failure_count: r.consecutive_failures ?? 0,
      last_failure_at: r.last_fired_at ?? r.last_succeeded_at ?? '',
    }));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'pulse.failing_triggers.failed',
    );
    return [];
  }
}

async function readRecentFindingClasses(
  db: DatabaseAdapter,
  now: number,
): Promise<string[]> {
  try {
    const cutoff = new Date(
      now - RECENT_FINDING_LOOKBACK_HOURS * 3_600_000,
    ).toISOString();
    const { data } = await db
      .from<FindingRow>('self_findings')
      .select('category, verdict, created_at')
      .eq('verdict', 'fail')
      .gte('created_at', cutoff);
    const seen = new Set<string>();
    for (const r of (data ?? []) as FindingRow[]) {
      if (r.category) seen.add(r.category);
    }
    return Array.from(seen);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'pulse.recent_finding_classes.failed',
    );
    return [];
  }
}

async function readToolingFriction(
  db: DatabaseAdapter,
  now: number,
): Promise<PulseToolingFriction[]> {
  try {
    const cutoff = new Date(now - 7 * 86_400_000).toISOString();
    const { data } = await db
      .from<FindingRow>('self_findings')
      .select('subject, category, created_at')
      .eq('category', 'tooling-friction')
      .gte('created_at', cutoff);
    const counts = new Map<string, number>();
    for (const r of (data ?? []) as FindingRow[]) {
      const name = r.subject ?? 'unknown';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const out: PulseToolingFriction[] = [];
    for (const [name, count] of counts.entries()) {
      if (count >= 2) out.push({ name, count });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'pulse.tooling_friction.failed',
    );
    return [];
  }
}

interface VitalsRow {
  ts: string;
  mrr: number | null;
  daily_cost_cents: number | null;
}

async function readBusinessVitals(
  db: DatabaseAdapter,
  workspace_id: string,
): Promise<{ mrr_cents?: number; daily_llm_cost_cents?: number }> {
  try {
    const { data } = await db
      .from<VitalsRow>('business_vitals')
      .select('ts, mrr, daily_cost_cents')
      .eq('workspace_id', workspace_id)
      .order('ts', { ascending: false })
      .limit(1);
    const row = (data ?? [])[0];
    if (!row) return {};
    return {
      mrr_cents: row.mrr ?? undefined,
      daily_llm_cost_cents: row.daily_cost_cents ?? undefined,
    };
  } catch (err) {
    logger.warn(
      { workspace_id, err: (err as Error).message },
      'pulse.business_vitals.failed',
    );
    return {};
  }
}

async function readPipelineCount(
  db: DatabaseAdapter,
  workspace_id: string,
): Promise<number | undefined> {
  try {
    const { data } = await db
      .from<{ contact_id: string }>('agent_workforce_contact_events')
      .select('contact_id')
      .eq('workspace_id', workspace_id)
      .eq('kind', 'x:qualified');
    const distinct = new Set(((data ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id));
    return distinct.size;
  } catch {
    return undefined;
  }
}

// ---- public ------------------------------------------------------------

export async function readFullPulse(
  db: DatabaseAdapter,
  workspace_id: string,
  nowMs?: number,
): Promise<FullPulseSnapshot> {
  const now = nowMs ?? Date.now();
  const ts = new Date(now).toISOString();

  const [
    approvals,
    rotting,
    qualified,
    dashboardRed,
    failingTriggers,
    findingClasses,
    toolingFriction,
    vitals,
    pipeline_count,
  ] = await Promise.all([
    readApprovalsPending(db, workspace_id, now),
    readRottingDeals(db, workspace_id, now),
    readQualifiedNoOutreach(db, workspace_id, now),
    readDashboardSmokeRed(db, now),
    readFailingTriggers(db),
    readRecentFindingClasses(db, now),
    readToolingFriction(db, now),
    readBusinessVitals(db, workspace_id),
    readPipelineCount(db, workspace_id),
  ]);

  return {
    ts,
    mrr_cents: vitals.mrr_cents,
    pipeline_count,
    approvals_pending: approvals.rows,
    deals_rotting: rotting,
    qualified_no_outreach: qualified,
    dashboard_smoke_red: dashboardRed,
    failing_triggers: failingTriggers,
    recent_finding_classes: findingClasses,
    tooling_friction_count_ge_2: toolingFriction,
    daily_llm_cost_cents: vitals.daily_llm_cost_cents,
    pending_approvals_count: approvals.count,
  };
}
