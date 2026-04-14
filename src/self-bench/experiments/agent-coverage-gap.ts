/**
 * AgentCoverageGapExperiment — Phase 6: experiment generation.
 *
 * The prior phases (1-5) run a fixed registered set of experiments
 * against known subjects. Phase 6 is where the system starts
 * generating probes against subjects it discovers at runtime:
 * specifically, individual agents in the workspace.
 *
 * Existing reliability coverage leaves agents uncovered. ModelHealth
 * walks every model, TriggerStability walks every trigger, Canary
 * hammers the tool substrate. But nothing looks at any individual
 * agent and asks "is this one healthy?" An agent that has been
 * quietly failing half its tasks for a week doesn't show up in any
 * existing finding until an operator happens to inspect it.
 *
 * This experiment fills the gap. Every run it:
 *   1. Reads agent_workforce_agents to get the full live set
 *   2. For each agent, queries task stats over the last 14 days
 *      (total count) and 7 days (fail rate)
 *   3. Flags agents as concerning when:
 *        - stale: zero tasks in 14 days despite a non-idle status
 *        - high_fail_rate: at least 5 tasks in last 7 days AND
 *          >50% of them are in status='failed'
 *   4. Writes the parent summary as the runner's own finding
 *   5. In intervene(), writes ONE additional finding per concerning
 *      agent with subject=`agent:<id>` so operators can filter the
 *      ledger to the specific agents needing attention without
 *      drowning in healthy-agent noise
 *
 * The per-agent findings are "generated experiments" in the
 * meaningful sense: their existence is not known at build time, and
 * the set of subjects they cover changes as the workspace's agent
 * roster changes. Tomorrow a new agent joins → tomorrow's tick
 * probes it. Deleted agents stop appearing in future findings. No
 * code change required.
 *
 * Cadence is hourly with runOnBoot: false — this is slow-moving
 * coverage signal, not an alarm. The adaptive scheduler can stretch
 * it to 2h/3h/4h if findings stay green, which is exactly the
 * "probe budget follows signal" behavior we want.
 *
 * No intervene mutations to system state, no validate, no rollback.
 * This is a pure observer that generates findings — the value is
 * in the ledger entries it produces, not in any config change.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  InterventionApplied,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { writeFinding } from '../findings-store.js';

/** How far back to look when checking if an agent has had any task activity at all. */
const STALENESS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Window for fail-rate calculation. */
const FAIL_RATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Minimum task count in the fail-rate window before the rate is considered meaningful. */
const FAIL_RATE_MIN_SAMPLES = 5;
/** Fail rate threshold for the concerning flag. */
const FAIL_RATE_THRESHOLD = 0.5;

interface AgentSummary {
  agent_id: string;
  agent_name: string;
  status: string;
  total_14d: number;
  tasks_7d: number;
  failed_7d: number;
  fail_rate_7d: number;
  stale: boolean;
  concerning: boolean;
  concern_reason?: string;
}

interface AgentCoverageEvidence extends Record<string, unknown> {
  total_agents: number;
  concerning_count: number;
  stale_count: number;
  high_fail_rate_count: number;
  agents: AgentSummary[];
}

interface AgentRow {
  id: string;
  name: string;
  status: string;
  workspace_id: string;
}

interface TaskRow {
  agent_id: string;
  status: string;
  created_at: string;
}

export class AgentCoverageGapExperiment implements Experiment {
  id = 'agent-coverage-gap';
  name = 'Per-agent health coverage gap-filler';
  category = 'other' as const;
  hypothesis =
    'Every agent in the workspace has recent task activity OR an idle status, and any agent with enough recent tasks has a failed-task ratio below 50%.';
  cadence = { everyMs: 60 * 60 * 1000, runOnBoot: false };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const now = Date.now();
    const stalenessCutoff = new Date(now - STALENESS_WINDOW_MS).toISOString();
    const failWindowCutoff = new Date(now - FAIL_RATE_WINDOW_MS).toISOString();

    const { data: agentData } = await ctx.db
      .from<AgentRow>('agent_workforce_agents')
      .select('id, name, status, workspace_id')
      .eq('workspace_id', ctx.workspaceId);

    const agents = (agentData ?? []) as AgentRow[];

    // One broader task query is cheaper than one-per-agent. Pull
    // every task from this workspace in the last 14 days, then
    // bucket by agent_id in memory.
    const { data: taskData } = await ctx.db
      .from<TaskRow>('agent_workforce_tasks')
      .select('agent_id, status, created_at')
      .eq('workspace_id', ctx.workspaceId)
      .gte('created_at', stalenessCutoff);

    const tasks = (taskData ?? []) as TaskRow[];
    const tasksByAgent = new Map<string, TaskRow[]>();
    for (const task of tasks) {
      const bucket = tasksByAgent.get(task.agent_id) ?? [];
      bucket.push(task);
      tasksByAgent.set(task.agent_id, bucket);
    }

    const summaries: AgentSummary[] = agents.map((agent) => {
      const agentTasks = tasksByAgent.get(agent.id) ?? [];
      const total14d = agentTasks.length;
      const tasks7d = agentTasks.filter((t) => t.created_at >= failWindowCutoff);
      const failed7d = tasks7d.filter((t) => t.status === 'failed').length;
      const failRate7d = tasks7d.length > 0 ? failed7d / tasks7d.length : 0;

      // Stale = zero task activity in 14 days with a non-idle status.
      // An agent that never had tasks and is already marked idle is
      // fine — they exist but haven't been used yet. A working
      // agent with zero tasks is the suspicious shape.
      const stale = total14d === 0 && agent.status !== 'idle';

      // High fail rate is only meaningful with enough samples.
      // Below FAIL_RATE_MIN_SAMPLES we can't tell the difference
      // between "actually broken" and "one bad run."
      const highFailRate =
        tasks7d.length >= FAIL_RATE_MIN_SAMPLES && failRate7d > FAIL_RATE_THRESHOLD;

      const concerning = stale || highFailRate;
      let concernReason: string | undefined;
      if (stale) concernReason = 'stale';
      else if (highFailRate) concernReason = 'high_fail_rate';

      return {
        agent_id: agent.id,
        agent_name: agent.name,
        status: agent.status,
        total_14d: total14d,
        tasks_7d: tasks7d.length,
        failed_7d: failed7d,
        fail_rate_7d: Math.round(failRate7d * 100) / 100,
        stale,
        concerning,
        concern_reason: concernReason,
      };
    });

    const concerning = summaries.filter((s) => s.concerning);
    const staleCount = summaries.filter((s) => s.stale).length;
    const highFailCount = summaries.filter(
      (s) => s.concerning && !s.stale,
    ).length;

    const evidence: AgentCoverageEvidence = {
      total_agents: summaries.length,
      concerning_count: concerning.length,
      stale_count: staleCount,
      high_fail_rate_count: highFailCount,
      agents: summaries,
    };

    const summary = summaries.length === 0
      ? 'no agents registered in this workspace — nothing to probe'
      : concerning.length === 0
        ? `inspected ${summaries.length} agent(s), all healthy`
        : `inspected ${summaries.length} agent(s), ${concerning.length} concerning (${staleCount} stale + ${highFailCount} high-fail-rate)`;

    return {
      subject: null,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as AgentCoverageEvidence;
    if (ev.total_agents === 0) return 'warning'; // no agents = odd shape
    if (ev.concerning_count === 0) return 'pass';
    return 'warning';
  }

  /**
   * Writes a per-agent finding for each concerning agent. These
   * are the "generated" ledger entries — their subjects
   * (`agent:{id}`) aren't known at build time, they come from
   * whatever agents exist in the workspace right now.
   *
   * Healthy agents get no per-agent finding so operator queries
   * stay focused on actionable state. The parent finding (written
   * by the runner after intervene returns) always captures the
   * full inspection via evidence.agents.
   */
  async intervene(
    _verdict: Verdict,
    result: ProbeResult,
    ctx: ExperimentContext,
  ): Promise<InterventionApplied | null> {
    const ev = result.evidence as AgentCoverageEvidence;
    if (ev.concerning_count === 0) return null;

    const writtenIds: string[] = [];
    for (const agent of ev.agents) {
      if (!agent.concerning) continue;
      try {
        const summary = agent.stale
          ? `agent "${agent.agent_name}" has had zero tasks in 14d despite status="${agent.status}" — unused or dormant`
          : `agent "${agent.agent_name}" has ${Math.round(agent.fail_rate_7d * 100)}% failure rate over ${agent.tasks_7d} recent task(s)`;

        const findingId = await writeFinding(ctx.db, {
          experimentId: this.id,
          category: 'other',
          subject: `agent:${agent.agent_id}`,
          hypothesis: `Gap-filler probe for agent ${agent.agent_name} (${agent.concern_reason})`,
          verdict: 'warning',
          summary,
          evidence: {
            is_gap_filler: true,
            agent_id: agent.agent_id,
            agent_name: agent.agent_name,
            agent_status: agent.status,
            concern_reason: agent.concern_reason,
            total_14d: agent.total_14d,
            tasks_7d: agent.tasks_7d,
            failed_7d: agent.failed_7d,
            fail_rate_7d: agent.fail_rate_7d,
          },
          interventionApplied: null,
          ranAt: new Date().toISOString(),
          durationMs: 0,
        });
        writtenIds.push(findingId);
      } catch {
        // Non-fatal — the next run will pick up anything we missed.
      }
    }

    if (writtenIds.length === 0) return null;

    return {
      description: `generated ${writtenIds.length} per-agent gap-filler finding(s) for concerning agents`,
      details: {
        gap_filler_finding_ids: writtenIds,
        concerning_count: ev.concerning_count,
        stale_count: ev.stale_count,
        high_fail_rate_count: ev.high_fail_rate_count,
      },
    };
  }
}
