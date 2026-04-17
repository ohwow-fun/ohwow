/**
 * kpi-registry.ts — declarative registry of outcome KPIs.
 *
 * The self-improvement loop's loss signal. An "experiment" today means
 * "probe + judge"; it doesn't compare outcomes. Phase 5 (credit
 * assignment) needs a stable way to read a KPI at commit time, again
 * at T+6h / 24h / 7d, and compare — so each autonomous commit can be
 * evaluated against the actual metric it claimed to move.
 *
 * This file declares every KPI the loop can reason about. Each entry
 * names:
 *   - id               stable string, used in trailer strings like
 *                      `Expected-Lift: revenue_cents_24h +500`
 *   - unit             'cents' | 'count' | 'ratio'
 *   - higher_is_better which direction moves the needle the right way
 *   - description      one-sentence explanation
 *   - saneRange?       [min, max] for observability dashboards
 *   - read(ctx)        async reader returning a number or null (read error)
 *
 * Readers MUST return:
 *   - a number when they can compute the value (0 is valid — "no revenue")
 *   - null only when the read errored or the upstream signal is missing
 *
 * RevenuePulse and other aggregators can co-exist with this registry —
 * they compute the same numbers inline today, and will migrate later.
 * Nothing in this file mutates; pure reads only.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { listFindings } from './findings-store.js';

export type KpiUnit = 'cents' | 'count' | 'ratio';

export interface KpiReadContext {
  db: DatabaseAdapter;
  /**
   * The resolved workspace row id (cloud UUID or 'local'). Same
   * contract as ExperimentContext.workspaceId — after consolidation
   * the literal 'local' never returns rows.
   */
  workspaceId: string;
  /**
   * Wall-clock ms for "now." Optional; defaults to Date.now(). Tests
   * pass a fixed value so windowed reads are deterministic regardless
   * of when the suite runs.
   */
  asOfMs?: number;
}

export interface KpiDefinition {
  id: string;
  description: string;
  unit: KpiUnit;
  higher_is_better: boolean;
  saneRange?: [number, number];
  read: (ctx: KpiReadContext) => Promise<number | null>;
}

export interface KpiReading {
  id: string;
  value: number | null;
  unit: KpiUnit;
  higher_is_better: boolean;
  saneRange: [number, number] | null;
  in_range: boolean | null;
  /** ISO timestamp the read was computed at. */
  at: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function nowMs(ctx: KpiReadContext): number {
  return ctx.asOfMs ?? Date.now();
}

async function sumRevenueSince(
  ctx: KpiReadContext,
  sinceIso: string,
): Promise<number | null> {
  try {
    const { data } = await ctx.db
      .from<{ amount_cents: number; created_at: string }>(
        'agent_workforce_revenue_entries',
      )
      .select('amount_cents,created_at')
      .eq('workspace_id', ctx.workspaceId)
      .gte('created_at', sinceIso)
      .limit(10000);
    let total = 0;
    for (const r of data ?? []) total += Number(r.amount_cents) || 0;
    return total;
  } catch {
    return null;
  }
}

async function countDms(
  ctx: KpiReadContext,
  direction: 'inbound' | 'outbound',
  sinceIso: string,
): Promise<number | null> {
  try {
    const { data } = await ctx.db
      .from<{ direction: string }>('x_dm_messages')
      .select('direction')
      .eq('workspace_id', ctx.workspaceId)
      .eq('direction', direction)
      .gte('observed_at', sinceIso)
      .limit(10000);
    return (data ?? []).length;
  } catch {
    return null;
  }
}

async function countContactsByStatus(
  ctx: KpiReadContext,
  status: string,
): Promise<number | null> {
  try {
    const { data } = await ctx.db
      .from<{ status: string }>('agent_workforce_contacts')
      .select('status')
      .eq('workspace_id', ctx.workspaceId)
      .eq('status', status)
      .limit(10000);
    return (data ?? []).length;
  } catch {
    return null;
  }
}

export const KPI_REGISTRY: readonly KpiDefinition[] = Object.freeze([
  {
    id: 'revenue_cents_24h',
    description: 'Realized revenue (cents) in the last 24 hours.',
    unit: 'cents',
    higher_is_better: true,
    read: (ctx) =>
      sumRevenueSince(ctx, new Date(nowMs(ctx) - DAY_MS).toISOString()),
  },
  {
    id: 'revenue_cents_7d',
    description: 'Realized revenue (cents) in the last 7 days.',
    unit: 'cents',
    higher_is_better: true,
    read: (ctx) =>
      sumRevenueSince(ctx, new Date(nowMs(ctx) - WEEK_MS).toISOString()),
  },
  {
    id: 'revenue_cents_mtd',
    description: 'Realized revenue (cents) month-to-date.',
    unit: 'cents',
    higher_is_better: true,
    read: async (ctx) => {
      try {
        const now = new Date(nowMs(ctx));
        const { data } = await ctx.db
          .from<{ amount_cents: number; month: number; year: number }>(
            'agent_workforce_revenue_entries',
          )
          .select('amount_cents,month,year')
          .eq('workspace_id', ctx.workspaceId)
          .eq('month', now.getUTCMonth() + 1)
          .eq('year', now.getUTCFullYear())
          .limit(10000);
        let total = 0;
        for (const r of data ?? []) total += Number(r.amount_cents) || 0;
        return total;
      } catch {
        return null;
      }
    },
  },
  {
    id: 'outbound_dm_24h',
    description: 'Outbound DMs in the last 24 hours.',
    unit: 'count',
    higher_is_better: true,
    saneRange: [1, 50],
    read: (ctx) =>
      countDms(ctx, 'outbound', new Date(nowMs(ctx) - DAY_MS).toISOString()),
  },
  {
    id: 'inbound_dm_24h',
    description: 'Inbound DMs in the last 24 hours.',
    unit: 'count',
    higher_is_better: true,
    read: (ctx) =>
      countDms(ctx, 'inbound', new Date(nowMs(ctx) - DAY_MS).toISOString()),
  },
  {
    id: 'reply_ratio_24h',
    description:
      'inbound_dm_24h / outbound_dm_24h. Null when outbound is zero.',
    unit: 'ratio',
    higher_is_better: true,
    saneRange: [0, 1],
    read: async (ctx) => {
      const since = new Date(nowMs(ctx) - DAY_MS).toISOString();
      const [out, inb] = await Promise.all([
        countDms(ctx, 'outbound', since),
        countDms(ctx, 'inbound', since),
      ]);
      if (out === null || inb === null) return null;
      if (out === 0) return null;
      return inb / out;
    },
  },
  {
    id: 'qualified_events_24h',
    description:
      "Count of contact_events with event_type starting with 'x:qualified' in 24h.",
    unit: 'count',
    higher_is_better: true,
    read: async (ctx) => {
      try {
        const since = new Date(nowMs(ctx) - DAY_MS).toISOString();
        const { data } = await ctx.db
          .from<{ event_type: string; created_at: string }>(
            'agent_workforce_contact_events',
          )
          .select('event_type,created_at')
          .eq('workspace_id', ctx.workspaceId)
          .gte('created_at', since)
          .limit(10000);
        let n = 0;
        for (const r of data ?? []) {
          if (typeof r.event_type === 'string' && r.event_type.startsWith('x:qualified')) n += 1;
        }
        return n;
      } catch {
        return null;
      }
    },
  },
  {
    id: 'active_leads',
    description: "Contacts with status='active' (leads in the pipeline).",
    unit: 'count',
    higher_is_better: true,
    read: (ctx) => countContactsByStatus(ctx, 'active'),
  },
  {
    id: 'active_customers',
    description: "Contacts with status='customer'.",
    unit: 'count',
    higher_is_better: true,
    read: (ctx) => countContactsByStatus(ctx, 'customer'),
  },
  {
    id: 'burn_cents_today',
    description:
      'LLM spend today in cents, read from the latest burn-rate finding. Lower is better.',
    unit: 'cents',
    higher_is_better: false,
    saneRange: [0, 10000],
    read: async (ctx) => {
      try {
        const rows = await listFindings(ctx.db, { experimentId: 'burn-rate', limit: 1 });
        const ev = rows[0]?.evidence as { total_cents_today?: number } | undefined;
        if (!ev) return null;
        return Number(ev.total_cents_today ?? 0);
      } catch {
        return null;
      }
    },
  },
  {
    id: 'signal_spend_ratio_24h',
    description:
      'revenue_cents_24h / burn_cents_today. Unit economics proxy; null when burn is zero.',
    unit: 'ratio',
    higher_is_better: true,
    read: async (ctx) => {
      const [rev, burn] = await Promise.all([
        sumRevenueSince(ctx, new Date(nowMs(ctx) - DAY_MS).toISOString()),
        (async (): Promise<number | null> => {
          try {
            const rows = await listFindings(ctx.db, { experimentId: 'burn-rate', limit: 1 });
            const ev = rows[0]?.evidence as { total_cents_today?: number } | undefined;
            return ev ? Number(ev.total_cents_today ?? 0) : null;
          } catch {
            return null;
          }
        })(),
      ]);
      if (rev === null || burn === null) return null;
      if (burn === 0) return null;
      return rev / burn;
    },
  },
]);

/** Lookup a KPI definition by id. */
export function getKpi(id: string): KpiDefinition | undefined {
  return KPI_REGISTRY.find((k) => k.id === id);
}

/** List every KPI id in the registry (stable order). */
export function listKpiIds(): string[] {
  return KPI_REGISTRY.map((k) => k.id);
}

function readingFor(
  def: KpiDefinition,
  value: number | null,
  at: string,
): KpiReading {
  const inRange = (() => {
    if (value === null || !def.saneRange) return null;
    return value >= def.saneRange[0] && value <= def.saneRange[1];
  })();
  return {
    id: def.id,
    value,
    unit: def.unit,
    higher_is_better: def.higher_is_better,
    saneRange: def.saneRange ?? null,
    in_range: inRange,
    at,
  };
}

/** Read one KPI by id. Returns null when no such KPI exists. */
export async function readKpi(
  id: string,
  ctx: KpiReadContext,
): Promise<KpiReading | null> {
  const def = getKpi(id);
  if (!def) return null;
  const at = new Date(nowMs(ctx)).toISOString();
  let value: number | null;
  try {
    value = await def.read(ctx);
  } catch {
    value = null;
  }
  return readingFor(def, value, at);
}

/** Read every KPI in the registry, in registry order. */
export async function readAllKpis(ctx: KpiReadContext): Promise<KpiReading[]> {
  const at = new Date(nowMs(ctx)).toISOString();
  const results: KpiReading[] = [];
  for (const def of KPI_REGISTRY) {
    let value: number | null;
    try {
      value = await def.read(ctx);
    } catch {
      value = null;
    }
    results.push(readingFor(def, value, at));
  }
  return results;
}

/**
 * Compute the signed "lift" between a before-reading and an after-reading
 * of the same KPI, normalized by the KPI's higher_is_better orientation
 * so a positive number always means "moved the right way."
 *
 * Returns null when either side is null (can't reason about missing data).
 */
export function signedLift(
  kpiId: string,
  before: number | null,
  after: number | null,
): number | null {
  if (before === null || after === null) return null;
  const def = getKpi(kpiId);
  if (!def) return null;
  const raw = after - before;
  return def.higher_is_better ? raw : -raw;
}
