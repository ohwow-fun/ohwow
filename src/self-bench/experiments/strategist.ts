/**
 * StrategistExperiment — a prefrontal-cortex pass for the autonomous loop.
 *
 * Everything else in the loop is *reactive* at the level of individual
 * findings: dashboard-copy writes a row per violation, patch-author
 * picks one candidate per tick, rollback flips one commit at a time.
 * None of them see the aggregate shape of the situation.
 *
 * This experiment runs every 15 minutes, reads:
 *   - active-finding counts per experiment (after supersession),
 *   - the latest patch-loop-health finding (hold_rate, pool delta),
 *   - the latest business_vitals row (daily_cost_cents, mrr),
 *   - the count of recent reflection observations.
 *
 * ...and writes three advisory keys to runtime_config_overrides:
 *   - strategy.active_focus           — short human-readable string
 *   - strategy.priority_experiments   — ordered list of experiment ids
 *                                       the scheduler should favor this
 *                                       window
 *   - strategy.demoted_experiments    — experiment ids the scheduler
 *                                       should run less often (e.g.
 *                                       when their pool is already
 *                                       well-covered)
 *
 * Downstream consumers (AdaptiveScheduler, PatchAuthor prompt, runner)
 * read these via getRuntimeConfig with sensible defaults, so the
 * strategist's absence never breaks anything. The intervention is
 * purely advisory — it does not change code, only shift priorities.
 *
 * Rollback semantics: deleteRuntimeConfig on the three keys. Reverts
 * the scheduler to its default cadences. Validation is a no-op (there
 * is no crisp "the strategy failed" signal on a 15m horizon; the next
 * strategist tick overwrites regardless).
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { setRuntimeConfig, deleteRuntimeConfig, getRuntimeConfig } from '../runtime-config.js';
import { STRATEGY_PERFORMATIVE_KEY } from './intervention-audit.js';

export const STRATEGY_ACTIVE_FOCUS_KEY = 'strategy.active_focus';
export const STRATEGY_PRIORITY_KEY = 'strategy.priority_experiments';
export const STRATEGY_DEMOTED_KEY = 'strategy.demoted_experiments';
export const STRATEGY_OVERWEIGHT_MODELS_KEY = 'strategy.overweight_models';

/**
 * Thresholds for the model-concentration rule. If one cloud model
 * eats more than MODEL_SHARE_THRESHOLD of today's burn AND fewer
 * than LOCAL_CALL_FLOOR of calls are hitting a local provider, the
 * strategist flags the model as overweight so the model router can
 * rebalance. Both thresholds must trip — a single dominant model is
 * fine when most traffic is local, and low local-ratio is fine if
 * spend is spread across providers.
 */
const MODEL_SHARE_THRESHOLD = 0.7;
const LOCAL_CALL_FLOOR = 0.2;

const STRATEGIST_ID = 'strategist';
const TICK_MS = 15 * 60 * 1000;

export interface StrategistEvidence {
  top_failing_experiments: Array<{ experiment_id: string; active_count: number }>;
  patch_loop?: { hold_rate: number | null; pool_delta: number | null; summary: string };
  burn?: { daily_cost_cents: number | null; mrr: number | null; ratio: number | null };
  burn_concentration?: {
    top_model: string | null;
    top_model_share: number | null;
    local_call_ratio: number | null;
    total_cents_today: number;
  };
  reflection_count_24h: number;
  decision: StrategyDecision;
}

export interface BurnConcentration {
  topModel: string | null;
  topModelShare: number | null;
  localCallRatio: number | null;
  totalCentsToday: number;
}

export interface StrategyDecision {
  active_focus: string;
  priority_experiments: string[];
  demoted_experiments: string[];
  overweight_models: string[];
}

/**
 * Pure decision function so the strategy can be tested without a DB.
 * Takes the aggregated facts and returns the three advisory fields.
 */
export function decideStrategy(facts: {
  topFailing: Array<{ experimentId: string; count: number }>;
  patchLoop: { holdRate: number | null; poolDelta: number | null } | null;
  burn: { ratio: number | null } | null;
  burnConcentration?: BurnConcentration | null;
  performativeExperiments?: string[];
  reflectionCount: number;
}): StrategyDecision {
  const priority: string[] = [];
  const demoted: string[] = [];
  const overweightModels: string[] = [];
  const reasons: string[] = [];

  // 1. Biggest active-finding backlog gets priority. We cap at 3 so
  //    the scheduler has room for everything else.
  const top3 = facts.topFailing.slice(0, 3).map((t) => t.experimentId);
  priority.push(...top3);
  if (top3.length > 0) {
    reasons.push(`drain backlog: ${top3.join(', ')}`);
  }

  // 2. Patch-loop state shapes the focus:
  //    - hold_rate low + pool growing  → loop is losing; prioritize
  //      patch-author + autonomous-patch-rollback, demote
  //      experiment-author (stop authoring new experiments while the
  //      existing ones are thrashing).
  //    - hold_rate high + pool shrinking → converging; let it run.
  //    - hold_rate high + pool growing → behind; widen patch-author.
  if (facts.patchLoop) {
    const { holdRate, poolDelta } = facts.patchLoop;
    const holdLow = typeof holdRate === 'number' && holdRate < 0.5;
    const poolUp = typeof poolDelta === 'number' && poolDelta > 0;
    if (holdLow && poolUp) {
      reasons.push('patch-loop losing; bias toward patch-author + rollback');
      if (!priority.includes('patch-author')) priority.unshift('patch-author');
      if (!priority.includes('autonomous-patch-rollback')) priority.push('autonomous-patch-rollback');
      if (!demoted.includes('experiment-author')) demoted.push('experiment-author');
    } else if (!holdLow && poolUp) {
      reasons.push('patch-loop behind; widen patch-author');
      if (!priority.includes('patch-author')) priority.unshift('patch-author');
    }
  }

  // 3. Burn pressure: when revenue_vs_burn ratio > 1 (cost exceeds
  //    daily revenue), demote expensive experiments. experiment-author
  //    and patch-author are the LLM-heavy ones; throttling them saves
  //    the most. The model router also sees the burn level via Week-3
  //    wiring and flips to local-only, but demoting the scheduler
  //    reduces the call *volume* on top of that.
  if (facts.burn && typeof facts.burn.ratio === 'number' && facts.burn.ratio > 1) {
    reasons.push(`burn ratio ${facts.burn.ratio.toFixed(2)} > 1; demote LLM-heavy experiments`);
    for (const id of ['experiment-author', 'patch-author']) {
      if (!demoted.includes(id)) demoted.push(id);
    }
    // When burn is bad, priority must not include LLM-heavy work.
    const idx1 = priority.indexOf('patch-author');
    if (idx1 >= 0) priority.splice(idx1, 1);
    const idx2 = priority.indexOf('experiment-author');
    if (idx2 >= 0) priority.splice(idx2, 1);
  }

  // 4. Model-burn concentration: when one cloud model eats the
  //    majority of today's spend AND local-call ratio is low, the
  //    router is routing too much toward a single provider. Flag the
  //    model as overweight so the router (or operator) can rebalance.
  //    Demote experiment-author too since it's the heaviest LLM
  //    consumer — throttling authoring frees the most budget while
  //    the rebalance catches up.
  if (facts.burnConcentration) {
    const { topModel, topModelShare, localCallRatio, totalCentsToday } =
      facts.burnConcentration;
    if (
      topModel &&
      topModelShare !== null &&
      localCallRatio !== null &&
      topModelShare > MODEL_SHARE_THRESHOLD &&
      localCallRatio < LOCAL_CALL_FLOOR &&
      totalCentsToday > 100
    ) {
      overweightModels.push(topModel);
      reasons.push(
        `model burn concentrated: ${Math.round(topModelShare * 100)}% on ${topModel}, ${Math.round(localCallRatio * 100)}% local`,
      );
      if (!demoted.includes('experiment-author')) demoted.push('experiment-author');
      const idx = priority.indexOf('experiment-author');
      if (idx >= 0) priority.splice(idx, 1);
    }
  }

  // 5. Performative experiments — their interventions don't hold per
  //    the InterventionAudit probe. Demote them so the scheduler
  //    stops spending budget running them on their normal cadence.
  //    Adaptive-scheduler will still fire them occasionally to catch
  //    a state change; demotion is just a priority hint, not a ban.
  const performative = facts.performativeExperiments ?? [];
  if (performative.length > 0) {
    reasons.push(`performative (hold<20%): ${performative.join(', ')}`);
    for (const id of performative) {
      if (!demoted.includes(id)) demoted.push(id);
      const idx = priority.indexOf(id);
      if (idx >= 0) priority.splice(idx, 1);
    }
  }

  const active_focus = reasons.length > 0 ? reasons.join('; ') : 'steady state — no intervention';
  return {
    active_focus,
    priority_experiments: dedup(priority),
    demoted_experiments: dedup(demoted),
    overweight_models: dedup(overweightModels),
  };
}

function dedup<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

interface FailingRow { experiment_id: string; c: number }
interface PatchLoopRow { summary: string; evidence: unknown; ran_at: string }
interface VitalRow { mrr: number | null; daily_cost_cents: number | null }
interface ReflectionRow { id: string }

export class StrategistExperiment implements Experiment {
  id = STRATEGIST_ID;
  name = 'Aggregate-state strategist';
  category = 'other' as const;
  hypothesis =
    'The experiment runner benefits from an aggregate view of the loop: which experiments have the biggest active backlog, whether the patch loop is converging, and whether revenue pressure requires throttling. A 15-minute pass over the ledger summarizes the situation and posts three advisory keys (focus, priorities, demoted) the scheduler reads.';
  cadence = { everyMs: TICK_MS, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const topFailing = await this.readTopFailingExperiments(ctx);
    const patchLoop = await this.readLatestPatchLoop(ctx);
    const burn = await this.readBurn(ctx);
    const burnConcentration = await this.readBurnConcentration(ctx);
    const reflectionCount = await this.readReflectionCount(ctx);
    const performativeExperiments = getRuntimeConfig<string[]>(
      STRATEGY_PERFORMATIVE_KEY,
      [],
    );

    const decision = decideStrategy({
      topFailing,
      patchLoop: patchLoop && {
        holdRate: extractHoldRate(patchLoop),
        poolDelta: extractPoolDelta(patchLoop),
      },
      burn,
      burnConcentration,
      performativeExperiments,
      reflectionCount,
    });

    const evidence: StrategistEvidence = {
      top_failing_experiments: topFailing.map((t) => ({
        experiment_id: t.experimentId,
        active_count: t.count,
      })),
      patch_loop: patchLoop
        ? {
            hold_rate: extractHoldRate(patchLoop),
            pool_delta: extractPoolDelta(patchLoop),
            summary: patchLoop.summary,
          }
        : undefined,
      burn: burn ? { ...burn } : undefined,
      burn_concentration: burnConcentration
        ? {
            top_model: burnConcentration.topModel,
            top_model_share: burnConcentration.topModelShare,
            local_call_ratio: burnConcentration.localCallRatio,
            total_cents_today: burnConcentration.totalCentsToday,
          }
        : undefined,
      reflection_count_24h: reflectionCount,
      decision,
    };

    const summary = `focus: ${decision.active_focus}`;
    return {
      subject: 'loop-strategy',
      summary,
      evidence: evidence as unknown as Record<string, unknown>,
    };
  }

  judge(_result: ProbeResult, _history: Finding[]): Verdict {
    // Observability, not failure detection. Every strategist tick is
    // useful signal; "pass" keeps the ledger clean of false alarms.
    return 'pass';
  }

  async intervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const decision = (result.evidence as unknown as StrategistEvidence).decision;
    await setRuntimeConfig(ctx.db, STRATEGY_ACTIVE_FOCUS_KEY, decision.active_focus, { setBy: this.id });
    await setRuntimeConfig(ctx.db, STRATEGY_PRIORITY_KEY, decision.priority_experiments, { setBy: this.id });
    await setRuntimeConfig(ctx.db, STRATEGY_DEMOTED_KEY, decision.demoted_experiments, { setBy: this.id });
    await setRuntimeConfig(ctx.db, STRATEGY_OVERWEIGHT_MODELS_KEY, decision.overweight_models, { setBy: this.id });
    return {
      description: `strategy: ${decision.active_focus}`,
      details: {
        priority_experiments: decision.priority_experiments,
        demoted_experiments: decision.demoted_experiments,
      },
    };
  }

  async rollback(
    _baseline: Record<string, unknown>,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    await deleteRuntimeConfig(ctx.db, STRATEGY_ACTIVE_FOCUS_KEY);
    await deleteRuntimeConfig(ctx.db, STRATEGY_PRIORITY_KEY);
    await deleteRuntimeConfig(ctx.db, STRATEGY_DEMOTED_KEY);
    await deleteRuntimeConfig(ctx.db, STRATEGY_OVERWEIGHT_MODELS_KEY);
    return { description: 'strategy keys cleared', details: {} };
  }

  // ------------------------------------------------------------
  // Reads. Each one is defensive — a missing table, an adapter
  // quirk, or an empty ledger must not break the probe.

  private async readTopFailingExperiments(
    ctx: ExperimentContext,
  ): Promise<Array<{ experimentId: string; count: number }>> {
    try {
      // Pull all active findings with fail/warning verdict in the
      // last 24h; aggregate in memory since the adapter surface is
      // narrow.
      const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data } = await ctx.db
        .from<{ experiment_id: string; verdict: string }>('self_findings')
        .select('experiment_id, verdict')
        .eq('status', 'active')
        .gte('ran_at', windowStart);
      const rows = (data ?? []) as Array<{ experiment_id: string; verdict: string }>;
      const counts = new Map<string, number>();
      for (const r of rows) {
        if (r.verdict !== 'fail' && r.verdict !== 'warning') continue;
        counts.set(r.experiment_id, (counts.get(r.experiment_id) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([experimentId, count]) => ({ experimentId, count }));
    } catch {
      return [];
    }
  }

  private async readLatestPatchLoop(ctx: ExperimentContext): Promise<PatchLoopRow | null> {
    try {
      const { data } = await ctx.db
        .from<PatchLoopRow>('self_findings')
        .select('summary, evidence, ran_at')
        .eq('experiment_id', 'patch-loop-health')
        .order('ran_at', { ascending: false })
        .limit(1);
      return ((data ?? []) as PatchLoopRow[])[0] ?? null;
    } catch {
      return null;
    }
  }

  private async readBurn(
    ctx: ExperimentContext,
  ): Promise<{ daily_cost_cents: number | null; mrr: number | null; ratio: number | null } | null> {
    try {
      const { data } = await ctx.db
        .from<VitalRow>('business_vitals')
        .select('mrr, daily_cost_cents')
        .order('ts', { ascending: false })
        .limit(1);
      const row = ((data ?? []) as VitalRow[])[0];
      if (!row) return null;
      const ratio = row.mrr && row.mrr > 0 && row.daily_cost_cents
        ? (row.daily_cost_cents / (row.mrr / 30))
        : null;
      return { daily_cost_cents: row.daily_cost_cents, mrr: row.mrr, ratio };
    } catch {
      return null;
    }
  }

  /**
   * Pull the latest meta:burn-rate finding from BurnRateExperiment
   * and compute the top model's share of today's spend + the local
   * call ratio. Returns null when the probe hasn't emitted yet or
   * the ledger read fails — the decision function tolerates a null
   * and simply skips the concentration rule.
   */
  private async readBurnConcentration(
    ctx: ExperimentContext,
  ): Promise<BurnConcentration | null> {
    try {
      const { data } = await ctx.db
        .from<{ evidence: unknown; ran_at: string }>('self_findings')
        .select('evidence, ran_at')
        .eq('experiment_id', 'burn-rate')
        .order('ran_at', { ascending: false })
        .limit(1);
      const row = ((data ?? []) as Array<{ evidence: unknown }>)[0];
      if (!row) return null;
      const ev = parseEvidence(row.evidence);
      const totalCentsToday = typeof ev.total_cents_today === 'number' ? ev.total_cents_today : 0;
      const localCallRatio =
        typeof ev.local_call_ratio === 'number' ? ev.local_call_ratio : null;
      const topRaw = ev.top_model_by_cost;
      let topModel: string | null = null;
      let topModelShare: number | null = null;
      if (topRaw && typeof topRaw === 'object') {
        const t = topRaw as { model?: unknown; cents?: unknown };
        if (typeof t.model === 'string') topModel = t.model;
        if (typeof t.cents === 'number' && totalCentsToday > 0) {
          topModelShare = t.cents / totalCentsToday;
        }
      }
      return { topModel, topModelShare, localCallRatio, totalCentsToday };
    } catch {
      return null;
    }
  }

  private async readReflectionCount(ctx: ExperimentContext): Promise<number> {
    try {
      const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data } = await ctx.db
        .from<ReflectionRow>('affective_memories')
        .select('id')
        .gte('created_at', windowStart);
      return ((data ?? []) as ReflectionRow[]).length;
    } catch {
      return 0;
    }
  }
}

// ----------------------------------------------------------------
// Evidence field extractors. patch-loop-health stores hold_rate /
// pool_delta on its evidence object; this strategist reads them
// without importing the producing experiment (to keep wiring loose).

function extractHoldRate(row: PatchLoopRow): number | null {
  const ev = parseEvidence(row.evidence);
  const v = ev.hold_rate;
  return typeof v === 'number' ? v : null;
}

function extractPoolDelta(row: PatchLoopRow): number | null {
  const ev = parseEvidence(row.evidence);
  const v = ev.pool_delta ?? ev.violation_pool_delta;
  return typeof v === 'number' ? v : null;
}

function parseEvidence(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
