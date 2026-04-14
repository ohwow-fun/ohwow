/**
 * AgentOutcomesExperiment — watches whether agents are actually
 * finishing the work they're given.
 *
 * Why this exists
 * ---------------
 * Every other self-bench experiment watches INFRASTRUCTURE: tools
 * respond, models emit tool_calls, triggers fire, schemas match
 * handlers, prose claims still hold. None of them look at the
 * metric that actually matters to the operator: are the agents
 * completing their tasks?
 *
 * A 2026-04-14 self-introspection run on ohwow-self surfaced this
 * gap by cross-checking self_findings against agent_workforce_tasks
 * and finding that while the ledger reported 100% pass across 67
 * rows, one agent (The Ear) had failed every single task over a
 * 7-hour window due to context-window blowouts — silently, with no
 * experiment ever noticing. Infrastructure works, outcomes don't,
 * self-bench couldn't tell the difference.
 *
 * This experiment closes that blind spot. It rolls up
 * agent_workforce_tasks by agent_id over a 24-hour window, computes
 * per-agent failure rate (status='failed' / total), and flags any
 * agent that has (a) received enough tasks to be statistically
 * meaningful and (b) failed more than half of them.
 *
 * Severity
 * --------
 * - pass:    no agent meets the offender threshold
 * - warning: 1 agent is failing most of its work
 * - fail:    2+ agents are failing — this is systemic, not one bad
 *            actor having a bad day
 *
 * No intervene
 * ------------
 * A failing agent is an operator / prompt-engineering / constraint
 * call, not something the runner can auto-heal. The probe's job is
 * to make the failure LOUD. The fix is always upstream of the
 * experiment: fine-tune the agent's system prompt, shrink its
 * context, tighten its tool allowlist, clamp it via per-agent
 * constraints (`config.model_policy.localOnly` or
 * `config.model_policy.maxCostCents` — see AgentModelPolicy in
 * execution-policy.ts), or retire it. The finding row carries the
 * specific agents + their rates so the operator (or a future
 * meta-experiment) can act.
 *
 * Note on "route it to a different model" as a remediation: that is
 * not a thing in shape C. Agents never pin a model; the router picks
 * per sub-task based on iteration/difficulty/purpose. The runtime's
 * automatic tier-ladder remediation already exists as
 * ModelHealthExperiment + refreshDemotedAgentModels — it blocklists
 * misbehaving models globally and escalateIfDemoted walks the next
 * call up the tier ladder (FREE → FAST → BALANCED → STRONG) for
 * every agent that would have landed on the demoted model. That
 * fixes bad-MODEL situations. This experiment watches bad-AGENT
 * situations, which are disjoint: the agent's failure may be its
 * prompt, context budget, or tool mix, not the model underneath.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { logger } from '../../lib/logger.js';

/** Lookback window for rolling failure-rate computation. */
const LOOKBACK_HOURS = 24;

/**
 * Minimum task count before an agent can be flagged. Below this the
 * denominator is too small for a rate to mean anything — one flake
 * on an agent that only ran 2 tasks isn't a 50% failure rate, it's
 * a single failure. Five is the smallest denominator that makes the
 * percentage meaningful.
 */
const MIN_TASKS_FOR_RATE = 5;

/**
 * Failure rate above which an agent is flagged. Half is deliberately
 * lenient — we're not trying to catch minor drift, we're trying to
 * catch silent drownings like the The Ear incident where the rate
 * was ~100%. A more sensitive threshold can ship later when the
 * ledger has enough per-agent baseline to bootstrap a z-score.
 */
const FAILURE_RATE_THRESHOLD = 0.5;

interface TaskRow {
  id: string;
  agent_id: string;
  status: string;
  created_at: string;
  error_message: string | null;
}

interface AgentRow {
  id: string;
  name: string;
}

interface OffenderRow {
  agent_id: string;
  agent_name: string;
  total_tasks: number;
  failed_tasks: number;
  failure_rate: number;
  sample_error: string | null;
}

interface AgentOutcomesEvidence extends Record<string, unknown> {
  lookback_hours: number;
  min_tasks_threshold: number;
  failure_rate_threshold: number;
  total_agents_checked: number;
  total_tasks_in_window: number;
  offenders: OffenderRow[];
}

export class AgentOutcomesExperiment implements Experiment {
  id = 'agent-outcomes';
  name = 'Per-agent task failure-rate watchdog';
  category = 'other' as const;
  hypothesis =
    'Every agent that has received at least MIN_TASKS_FOR_RATE tasks in the last LOOKBACK_HOURS completes more than half of them — no agent is silently drowning in failures that the infrastructure-level experiments are blind to.';
  // 15 min cadence on boot: this is one of the few experiments
  // whose finding is directly actionable the moment it lands, and
  // an operator staring at a fresh daemon should see task-outcome
  // status within the first tick instead of waiting for the
  // scheduled cycle.
  cadence = { everyMs: 15 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const cutoffIso = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

    const { data: taskData } = await ctx.db
      .from<TaskRow>('agent_workforce_tasks')
      .select('id, agent_id, status, created_at, error_message')
      .eq('workspace_id', ctx.workspaceId)
      .gte('created_at', cutoffIso);

    const tasks = (taskData ?? []) as TaskRow[];

    // Bucket by agent_id. Keep the first non-empty error_message we
    // see per agent so the evidence carries a representative sample
    // for the operator without dragging every row along.
    const byAgent = new Map<
      string,
      { total: number; failed: number; sampleError: string | null }
    >();
    for (const t of tasks) {
      const bucket = byAgent.get(t.agent_id) ?? { total: 0, failed: 0, sampleError: null };
      bucket.total += 1;
      if (t.status === 'failed') {
        bucket.failed += 1;
        if (!bucket.sampleError && t.error_message) {
          bucket.sampleError = t.error_message.slice(0, 200);
        }
      }
      byAgent.set(t.agent_id, bucket);
    }

    // Resolve agent names so the evidence is human-readable. A
    // single follow-up select keeps the query budget at 2 round
    // trips regardless of how many agents are involved.
    const agentIds = Array.from(byAgent.keys());
    const nameById = new Map<string, string>();
    if (agentIds.length > 0) {
      try {
        const { data: agentData } = await ctx.db
          .from<AgentRow>('agent_workforce_agents')
          .select('id, name')
          .in('id', agentIds);
        for (const a of (agentData ?? []) as AgentRow[]) {
          nameById.set(a.id, a.name);
        }
      } catch (err) {
        logger.debug({ err }, '[agent-outcomes] agent name lookup failed; falling back to ids');
      }
    }

    const offenders: OffenderRow[] = [];
    for (const [agentId, stats] of byAgent.entries()) {
      if (stats.total < MIN_TASKS_FOR_RATE) continue;
      const rate = stats.failed / stats.total;
      if (rate < FAILURE_RATE_THRESHOLD) continue;
      offenders.push({
        agent_id: agentId,
        agent_name: nameById.get(agentId) ?? agentId,
        total_tasks: stats.total,
        failed_tasks: stats.failed,
        failure_rate: Math.round(rate * 1000) / 1000,
        sample_error: stats.sampleError,
      });
    }

    // Worst offender first so the subject + summary point at the
    // most urgent case.
    offenders.sort((a, b) => b.failure_rate - a.failure_rate || b.total_tasks - a.total_tasks);

    const evidence: AgentOutcomesEvidence = {
      lookback_hours: LOOKBACK_HOURS,
      min_tasks_threshold: MIN_TASKS_FOR_RATE,
      failure_rate_threshold: FAILURE_RATE_THRESHOLD,
      total_agents_checked: byAgent.size,
      total_tasks_in_window: tasks.length,
      offenders,
    };

    const summary = offenders.length === 0
      ? `${byAgent.size} agent(s) checked across ${tasks.length} task(s) in last ${LOOKBACK_HOURS}h — no offenders`
      : offenders.length === 1
        ? `${offenders[0].agent_name} failing ${offenders[0].failed_tasks}/${offenders[0].total_tasks} (${Math.round(offenders[0].failure_rate * 100)}%)`
        : `${offenders.length} agents failing majority of their work; worst: ${offenders[0].agent_name} at ${Math.round(offenders[0].failure_rate * 100)}%`;

    const subject = offenders.length > 0 ? `agent:${offenders[0].agent_id}` : null;
    return { subject, summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as AgentOutcomesEvidence;
    if (ev.offenders.length === 0) return 'pass';
    // One bad agent is a warning — could be a single broken prompt
    // or a transient provider issue isolated to that agent's model.
    // Two or more is systemic: either the environment regressed
    // (provider outage, context-compaction bug, a shared tool that
    // every agent relies on), or the same root cause is hitting
    // multiple agents at once.
    if (ev.offenders.length === 1) return 'warning';
    return 'fail';
  }
}
