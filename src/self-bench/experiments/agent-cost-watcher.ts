/**
 * AgentTaskCostWatcherExperiment — Phase 8-B.
 *
 * A pure-observer BusinessExperiment that tracks the rolling 7-day
 * average cost per completed task and warns when it exceeds an active
 * goal's target. No intervention fires today — the base class default
 * businessIntervene returns null. Phase 8-B.2 will add a tuning knob
 * (model tier preference) once the routing seam exists in model-router.ts.
 *
 * Why build an observer before the tuner?
 * ----------------------------------------
 * ContentCadenceTunerExperiment exercises the full intervene/validate/
 * rollback loop. What the ledger needs next is evidence that the business
 * metric pattern (workspace guard + goal anchoring + DB-computable metric)
 * generalises to a second axis of measurement. An observer that requires
 * zero runtime consumers is the right first step: once the probe + judge
 * are producing good signal in the ledger, adding the intervention is a
 * small isolated addition.
 *
 * Metric source
 * -------------
 * agent_workforce_tasks.cost_cents — written by execution/engine.ts at
 * task completion, carries the actual paid API cost (0 for Ollama tasks).
 * The 7-day rolling window means the watcher is immune to single-day
 * spikes while still responding to sustained drift.
 *
 * Goal anchoring
 * --------------
 * Anchors to target_metric='agent_avg_task_cost_cents'. The operator creates
 * this goal via the goals UI and sets a target value (e.g. 5.0 for "no more
 * than 5 cents per task on average"). If no goal exists, businessProbe returns
 * pass with reason 'no_goal' — same pattern as ContentCadenceTunerExperiment.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { BusinessExperiment } from '../business-experiment.js';
import type {
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

/** Goal target_metric this experiment looks for. */
export const AGENT_COST_GOAL_METRIC = 'agent_avg_task_cost_cents';

/** Rolling window for cost computation. */
const ROLLING_WINDOW_DAYS = 7;
const ROLLING_WINDOW_MS = ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

interface CostWatchEvidence extends Record<string, unknown> {
  task_count?: number;
  avg_cost_cents?: number;
  target_cost_cents?: number;
  over_budget?: boolean;
  window_days: number;
  goal_id?: string;
  goal_title?: string;
  reason?: string;
}

export class AgentTaskCostWatcherExperiment extends BusinessExperiment {
  id = 'agent-cost-watcher';
  name = 'Agent task cost watcher';
  hypothesis =
    `Rolling ${ROLLING_WINDOW_DAYS}-day avg cost per completed task stays below ` +
    `the active '${AGENT_COST_GOAL_METRIC}' goal target. ` +
    `Emits 'warning' when avg exceeds target so the ledger captures sustained drift.`;
  cadence = {
    everyMs: 6 * 60 * 60 * 1000,
    runOnBoot: false,
  };

  protected async businessProbe(ctx: ExperimentContext): Promise<ProbeResult> {
    const goal = await this.findActiveGoalByMetric(ctx, AGENT_COST_GOAL_METRIC);

    const since = new Date(Date.now() - ROLLING_WINDOW_MS).toISOString();
    const { taskCount, avgCost } = await this.computeRollingAvgCost(ctx.db, ctx.workspaceId, since);

    if (!goal) {
      const evidence: CostWatchEvidence = {
        task_count: taskCount,
        avg_cost_cents: avgCost ?? undefined,
        window_days: ROLLING_WINDOW_DAYS,
        reason: 'no_goal',
      };
      return {
        subject: null,
        summary: `no active goal with target_metric='${AGENT_COST_GOAL_METRIC}' — watching without target`,
        evidence,
      };
    }

    if (taskCount === 0) {
      const evidence: CostWatchEvidence = {
        task_count: 0,
        window_days: ROLLING_WINDOW_DAYS,
        goal_id: goal.id,
        goal_title: goal.title,
        target_cost_cents: goal.targetValue,
        reason: 'no_tasks_in_window',
      };
      return {
        subject: `goal:${goal.id}`,
        summary: `no completed tasks with cost data in the last ${ROLLING_WINDOW_DAYS} days`,
        evidence,
      };
    }

    const avg = avgCost ?? 0;
    const overBudget = avg > goal.targetValue;

    const evidence: CostWatchEvidence = {
      task_count: taskCount,
      avg_cost_cents: Math.round(avg * 100) / 100,
      target_cost_cents: goal.targetValue,
      over_budget: overBudget,
      window_days: ROLLING_WINDOW_DAYS,
      goal_id: goal.id,
      goal_title: goal.title,
    };

    const summary = overBudget
      ? `avg task cost ${evidence.avg_cost_cents}¢ exceeds target ${goal.targetValue}¢ ` +
        `(${taskCount} tasks in last ${ROLLING_WINDOW_DAYS}d)`
      : `avg task cost ${evidence.avg_cost_cents}¢ within target ${goal.targetValue}¢ ` +
        `(${taskCount} tasks in last ${ROLLING_WINDOW_DAYS}d)`;

    return {
      subject: `goal:${goal.id}`,
      summary,
      evidence,
    };
  }

  protected businessJudge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as CostWatchEvidence;
    return ev.over_budget === true ? 'warning' : 'pass';
  }

  // No businessIntervene override. Base class returns null — pure observer.
  // Phase 8-B.2: add model tier preference knob when routing seam exists.

  /**
   * Compute task count and average cost for this workspace over the
   * given trailing window. Only counts tasks with cost_cents > 0 (paid
   * API calls) so Ollama-only workspaces don't flood the average with zeros.
   */
  private async computeRollingAvgCost(
    db: DatabaseAdapter,
    workspaceId: string,
    since: string,
  ): Promise<{ taskCount: number; avgCost: number | null }> {
    try {
      const { data } = await db
        .from<{ cost_cents: number | null; completed_at: string | null }>('agent_workforce_tasks')
        .select('cost_cents, completed_at')
        .eq('workspace_id', workspaceId)
        .eq('status', 'completed');

      const rows = (data ?? []) as Array<{
        cost_cents: number | null;
        completed_at: string | null;
      }>;

      const paid = rows.filter(
        (r) =>
          r.completed_at &&
          r.completed_at >= since &&
          typeof r.cost_cents === 'number' &&
          r.cost_cents > 0,
      );

      if (paid.length === 0) return { taskCount: 0, avgCost: null };

      const total = paid.reduce<number>((acc, r) => acc + (r.cost_cents ?? 0), 0);
      return { taskCount: paid.length, avgCost: total / paid.length };
    } catch {
      return { taskCount: 0, avgCost: null };
    }
  }
}
