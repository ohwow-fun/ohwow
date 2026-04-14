/**
 * BusinessExperiment — abstract base class for the self-bench
 * experiments that target business outcomes instead of
 * infrastructure reliability.
 *
 * Why this is a separate base class
 * ---------------------------------
 * Infra experiments (model_health, stale-task-cleanup, canaries) run
 * against daemon-local state and are safe to run on any workspace —
 * worst case a cleanup fires on a customer workspace and clears some
 * zombies. Business experiments are different: their interventions
 * influence outbound behavior that touches the outside world
 * (post cadence, outreach volume, cohort targeting), and running
 * them on a customer workspace would mean the runtime is spending
 * the customer's credits on experiments they didn't consent to.
 *
 * The base class enforces three things every business experiment
 * has to get right, so subclasses can't forget:
 *
 *   1. **Workspace guard.** probe() is wrapped so it short-circuits
 *      into a 'skipped' result when ctx.workspaceSlug is not the
 *      allowedWorkspace (default: 'default', the GTM dogfood slot).
 *      Matches on the slug, not the consolidated workspaceId row id,
 *      because the id is rewritten to the cloud UUID / 'local'
 *      sentinel at daemon boot and stops being the human-readable
 *      name. judge() returns 'pass' on skipped probes. intervene()
 *      returns null on skipped probes or mismatched workspaces. All
 *      three gates are belt-and-braces — any one of them is sufficient.
 *
 *   2. **Goal anchoring.** Business experiments probe against
 *      agent_workforce_goals via findActiveGoalByMetric(). Goals
 *      already carry target_metric + target_value + current_value +
 *      due_date, which is exactly the shape probe/judge want. This
 *      keeps the experiment honest — it can't "pass" without a
 *      measurable target outside itself.
 *
 *   3. **Soft rollback reality.** Infra interventions are reversible
 *      (deleteRuntimeConfig restores the default). Business
 *      interventions often aren't — an X post or a DM can't be
 *      unsent. The base exposes interventionCapReached() so
 *      subclasses can enforce hard daily caps as a substitute for
 *      true reversibility. Subclasses that mutate actual outbound
 *      state must also mark their interventions with reversible=false
 *      in the InterventionApplied details and rely on caps + cohort
 *      cooldown instead of literal undo.
 *
 * The template-method pattern
 * ---------------------------
 * Subclasses override the `businessProbe` / `businessJudge` /
 * `businessIntervene` hooks. The public `probe` / `judge` /
 * `intervene` methods on the base apply the guards and then delegate.
 * This means a subclass author physically cannot skip the workspace
 * guard by reimplementing probe — the runner calls the base's probe,
 * not the subclass's businessProbe directly.
 *
 * validate() and rollback() are NOT wrapped. They run inside the
 * validation window, after the intervention has already committed,
 * and the runner has its own validation-store guarantees. Subclasses
 * implement them directly per the Experiment interface.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';
import type {
  Experiment,
  ExperimentCadence,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from './experiment-types.js';

/** Default workspace slug business experiments are allowed to target. */
export const DEFAULT_BUSINESS_WORKSPACE = 'default';

export interface BusinessExperimentOptions {
  /**
   * Workspace slug this experiment is allowed to run against. Defaults
   * to the GTM dogfood workspace ('default'). Subclasses can widen
   * this, but the common case is to inherit the default and refuse
   * to run anywhere else.
   */
  allowedWorkspace?: string;
}

/** Minimal goal shape used by business experiments. */
export interface BusinessGoal {
  id: string;
  title: string;
  targetMetric: string | null;
  targetValue: number;
  currentValue: number;
  unit: string | null;
  dueDate: string | null;
}

/** Output of computeRequiredVelocity. */
export interface VelocityComputation {
  remainingValue: number;
  daysRemaining: number;
  requiredPerDay: number;
}

interface GoalRow {
  id: string;
  title: string;
  target_metric: string | null;
  target_value: number | null;
  current_value: number | null;
  unit: string | null;
  due_date: string | null;
  status: string;
}

/** Evidence key every skipped probe result carries. Checked by judge + intervene. */
const SKIP_MARKER = 'skipped';

export function wasProbeSkipped(result: ProbeResult): boolean {
  const ev = result.evidence as { [SKIP_MARKER]?: boolean };
  return ev[SKIP_MARKER] === true;
}

export abstract class BusinessExperiment implements Experiment {
  abstract id: string;
  abstract name: string;
  category: ExperimentCategory = 'business_outcome';
  abstract hypothesis: string;
  abstract cadence: ExperimentCadence;

  readonly allowedWorkspace: string;

  constructor(opts: BusinessExperimentOptions = {}) {
    this.allowedWorkspace = opts.allowedWorkspace ?? DEFAULT_BUSINESS_WORKSPACE;
  }

  // Subclass hooks. The `business*` names make it obvious at every
  // callsite whether a method is the guarded public contract or the
  // raw subclass body.
  protected abstract businessProbe(ctx: ExperimentContext): Promise<ProbeResult>;
  protected abstract businessJudge(result: ProbeResult, history: Finding[]): Verdict;

  /**
   * Subclasses override this to implement interventions. Default is
   * observer-only (returns null), so a business experiment that only
   * watches goals without acting on them is a one-method override:
   * just implement businessProbe + businessJudge.
   */
  protected businessIntervene(
    _verdict: Verdict,
    _result: ProbeResult,
    _ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    return Promise.resolve(null);
  }

  // Public Experiment interface methods. The runner calls these. They
  // apply the guards and delegate to the business* hooks.

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    if (!this.isAllowedWorkspace(ctx)) {
      const actual = this.resolveSlug(ctx);
      return {
        subject: null,
        summary: `skipped: ${this.id} only runs on '${this.allowedWorkspace}' workspace, got '${actual}'`,
        evidence: {
          [SKIP_MARKER]: true,
          reason: 'workspace_guard',
          allowed_workspace: this.allowedWorkspace,
          actual_workspace: actual,
        },
      };
    }
    return this.businessProbe(ctx);
  }

  judge(result: ProbeResult, history: Finding[]): Verdict {
    if (wasProbeSkipped(result)) return 'pass';
    return this.businessJudge(result, history);
  }

  async intervene(
    verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    if (wasProbeSkipped(result)) return null;
    if (!this.isAllowedWorkspace(ctx)) return null;
    return this.businessIntervene(verdict, result, ctx);
  }

  // Helpers subclasses use inside business* hooks.

  protected isAllowedWorkspace(ctx: ExperimentContext): boolean {
    return this.resolveSlug(ctx) === this.allowedWorkspace;
  }

  /**
   * Resolve the workspace slug for guard matching. Prefers the
   * runner-provided ctx.workspaceSlug, falls back to OHWOW_WORKSPACE
   * when a test harness constructs a context directly without
   * populating the field, and finally defaults to DEFAULT_BUSINESS_WORKSPACE
   * so a missing env var in tests doesn't accidentally open the guard.
   * Never reads ctx.workspaceId for this decision — that's the
   * consolidated row id, not the slug.
   */
  protected resolveSlug(ctx: ExperimentContext): string {
    if (typeof ctx.workspaceSlug === 'string' && ctx.workspaceSlug.length > 0) {
      return ctx.workspaceSlug;
    }
    const fromEnv = process.env.OHWOW_WORKSPACE?.trim();
    if (fromEnv && fromEnv.length > 0) return fromEnv;
    return DEFAULT_BUSINESS_WORKSPACE;
  }

  /**
   * Find the first active goal matching a target_metric. Returns null
   * if no goal is found — subclasses treat that as "nothing to
   * experiment against, pass the probe." Never throws.
   */
  protected async findActiveGoalByMetric(
    ctx: ExperimentContext,
    metric: string,
  ): Promise<BusinessGoal | null> {
    try {
      const res = await (ctx.db as DatabaseAdapter)
        .from<GoalRow>('agent_workforce_goals')
        .select('id, title, target_metric, target_value, current_value, unit, due_date, status')
        .eq('workspace_id', ctx.workspaceId)
        .eq('target_metric', metric)
        .eq('status', 'active');
      const rows = ((res as { data?: GoalRow[] | null }).data ?? []) as GoalRow[];
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        targetMetric: row.target_metric,
        targetValue: Number(row.target_value ?? 0),
        currentValue: Number(row.current_value ?? 0),
        unit: row.unit ?? null,
        dueDate: row.due_date ?? null,
      };
    } catch (err) {
      logger.warn({ err, metric }, '[business-experiment] findActiveGoalByMetric failed');
      return null;
    }
  }

  /**
   * Given a goal with a due date, compute how fast current_value
   * needs to move to hit target_value by the deadline. Returns null
   * if the goal has no due date, is already met, or the deadline has
   * already passed — in all three cases there's nothing to tune
   * toward.
   */
  protected computeRequiredVelocity(
    goal: BusinessGoal,
    now: Date = new Date(),
  ): VelocityComputation | null {
    if (!goal.dueDate) return null;
    const due = new Date(goal.dueDate).getTime();
    const msLeft = due - now.getTime();
    if (msLeft <= 0) return null;
    const remainingValue = Math.max(0, goal.targetValue - goal.currentValue);
    if (remainingValue === 0) return null;
    const daysRemaining = msLeft / (24 * 60 * 60 * 1000);
    return {
      remainingValue,
      daysRemaining,
      requiredPerDay: remainingValue / daysRemaining,
    };
  }

  /**
   * Returns true when this experiment has already performed at least
   * `maxPerWindow` interventions in the last `windowMs`. Subclasses
   * that mutate outbound-affecting state call this before committing
   * another change, as a hard brake that survives even a misbehaving
   * judge that keeps returning 'warning'.
   *
   * Reads the same self_findings ledger everything else writes to,
   * so the cap is durable across daemon restarts.
   */
  protected async interventionCapReached(
    ctx: ExperimentContext,
    maxPerWindow: number,
    windowMs: number,
  ): Promise<boolean> {
    if (maxPerWindow <= 0) return true;
    const history = await ctx.recentFindings(this.id, 50);
    const cutoff = Date.now() - windowMs;
    const intervened = history.filter((f) => {
      if (!f.interventionApplied) return false;
      const t = new Date(f.ranAt).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
    return intervened.length >= maxPerWindow;
  }
}
