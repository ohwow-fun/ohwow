/**
 * AgentLockContentionExperiment — Phase 8-A.2
 *
 * Detects agents that are marked `status='working'` on the
 * `agent_workforce_agents` table while their active task has
 * stalled (either the task has no matching in_progress task,
 * or the task's updated_at hasn't moved in >30 minutes).
 *
 * Emits:
 *   pass    — all working agents have a live, recently-updated task
 *   warning — 10–30% of working agents appear stalled
 *   fail    — >30% of working agents appear stalled
 *
 * Why this matters: the stale-task-cleanup sweep frees zombies every
 * 5 minutes, but there is no probe that tells you "right now, 40% of
 * your agents are blocked." The difference between normal operations
 * and a cascading stall is invisible until the UI shows everything
 * stuck. This experiment provides that early signal.
 *
 * No intervene — clearing stale tasks requires verification that the
 * associated work is truly dead, not just slow. The operator or the
 * stale-cleanup service handles the actual reset.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

/** Threshold: if a task's updated_at is older than this, consider it stalled. */
const STALL_THRESHOLD_MINUTES = 30;

const WARNING_STALL_RATE = 0.10; // 10% of working agents stalled → warning
const FAIL_STALL_RATE = 0.30;    // 30% → fail

interface AgentRow {
  id: string;
  name: string;
}

interface TaskRow {
  id: string;
  agent_id: string;
  updated_at: string;
}

interface StalledAgent {
  agent_id: string;
  agent_name: string;
  task_id: string | null;
  task_updated_at: string | null;
  stall_reason: 'no_active_task' | 'task_not_updated';
  stall_minutes: number | null;
}

interface AgentLockEvidence extends Record<string, unknown> {
  working_agent_count: number;
  stalled_agent_count: number;
  stall_rate: number;
  stall_threshold_minutes: number;
  stalled_agents: StalledAgent[];
}

export class AgentLockContentionExperiment implements Experiment {
  id = 'agent-lock-contention';
  name = 'Agent lock contention detector';
  category = 'trigger_stability' as const;
  hypothesis =
    'Fewer than 10% of working agents are blocked on stalled tasks at any point in time. Elevated lock contention surfaces before the UI shows cascading stucks.';
  cadence = { everyMs: 10 * 60 * 1000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const stallCutoff = new Date(
      Date.now() - STALL_THRESHOLD_MINUTES * 60 * 1000,
    ).toISOString();

    // All agents currently marked as working
    const { data: agentData } = await ctx.db
      .from<AgentRow>('agent_workforce_agents')
      .select('id, name')
      .eq('workspace_id', ctx.workspaceId)
      .eq('status', 'working');

    const workingAgents = (agentData ?? []) as AgentRow[];

    if (workingAgents.length === 0) {
      const evidence: AgentLockEvidence = {
        working_agent_count: 0,
        stalled_agent_count: 0,
        stall_rate: 0,
        stall_threshold_minutes: STALL_THRESHOLD_MINUTES,
        stalled_agents: [],
      };
      return {
        subject: null,
        summary: 'no agents currently working',
        evidence,
      };
    }

    // Fetch all in_progress tasks for this workspace in one query to
    // avoid N+1 per agent. We then join in JS.
    const { data: taskData } = await ctx.db
      .from<TaskRow>('agent_workforce_tasks')
      .select('id, agent_id, updated_at')
      .eq('workspace_id', ctx.workspaceId)
      .eq('status', 'in_progress');

    const inProgressTasks = (taskData ?? []) as TaskRow[];

    // Build a map: agent_id → most-recently-updated in_progress task
    const taskByAgent = new Map<string, TaskRow>();
    for (const task of inProgressTasks) {
      const existing = taskByAgent.get(task.agent_id);
      if (!existing || task.updated_at > existing.updated_at) {
        taskByAgent.set(task.agent_id, task);
      }
    }

    const stalledAgents: StalledAgent[] = [];

    for (const agent of workingAgents) {
      const task = taskByAgent.get(agent.id);

      if (!task) {
        // Agent is "working" but has no in_progress task — zombie agent
        stalledAgents.push({
          agent_id: agent.id,
          agent_name: agent.name,
          task_id: null,
          task_updated_at: null,
          stall_reason: 'no_active_task',
          stall_minutes: null,
        });
        continue;
      }

      if (task.updated_at < stallCutoff) {
        const stallMs = Date.now() - new Date(task.updated_at).getTime();
        stalledAgents.push({
          agent_id: agent.id,
          agent_name: agent.name,
          task_id: task.id,
          task_updated_at: task.updated_at,
          stall_reason: 'task_not_updated',
          stall_minutes: Math.round(stallMs / 60_000),
        });
      }
    }

    const stallRate = stalledAgents.length / workingAgents.length;

    const evidence: AgentLockEvidence = {
      working_agent_count: workingAgents.length,
      stalled_agent_count: stalledAgents.length,
      stall_rate: stallRate,
      stall_threshold_minutes: STALL_THRESHOLD_MINUTES,
      stalled_agents: stalledAgents,
    };

    const summary =
      stalledAgents.length === 0
        ? `all ${workingAgents.length} working agent(s) have active tasks`
        : `${stalledAgents.length}/${workingAgents.length} agents stalled (${(stallRate * 100).toFixed(0)}%)`;

    return {
      subject: stalledAgents.length > 0 ? stalledAgents[0].agent_id : null,
      summary,
      evidence,
    };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as AgentLockEvidence;
    if (ev.working_agent_count === 0) return 'pass';
    if (ev.stall_rate >= FAIL_STALL_RATE) return 'fail';
    if (ev.stall_rate >= WARNING_STALL_RATE) return 'warning';
    return 'pass';
  }
}
