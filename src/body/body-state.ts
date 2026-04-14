/**
 * Body State Service — Unified system health reporting.
 *
 * Reports the state of the system's "body" as a coherent whole:
 * - Organ health (which integrations are active, degraded, or down)
 * - Task performance (recent success rates per agent)
 * - Memory pressure (active count vs cap)
 * - Cost trajectory (recent spend rate)
 * - Pending work (in-flight tasks, pending approvals)
 *
 * Exposed as:
 * 1. A tool agents can query (get_body_state)
 * 2. Proprioceptive input fed into Brain.perceive()
 *
 * Compatible with the cloud dashboard's body-state.ts service.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { DigitalBody } from './digital-body.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface OrganStatus {
  id: string;
  name: string;
  health: 'healthy' | 'degraded' | 'failed' | 'dormant';
  active: boolean;
}

export interface AgentPerformance {
  agentId: string;
  agentName: string;
  recentSuccessRate: number;
  tasksLast24h: number;
}

export interface BodyState {
  /** Overall system health: healthy, degraded, or critical */
  overallHealth: 'healthy' | 'degraded' | 'critical';
  /** Status of each organ (integration endpoint) */
  organs: OrganStatus[];
  /** Recent task performance per agent */
  agentPerformance: AgentPerformance[];
  /** Memory system pressure */
  memory: {
    activeCount: number;
    cap: number;
    pressure: 'low' | 'medium' | 'high';
  };
  /** Task pipeline status */
  pipeline: {
    pending: number;
    inProgress: number;
    pendingApprovals: number;
    failedLast24h: number;
  };
  /** Cost trajectory */
  cost: {
    last24hCents: number;
    last7dCents: number;
  };
  /** Snapshot timestamp */
  timestamp: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum active memories per agent before pressure is "high" */
const MEMORY_CAP = 1000;
const MEMORY_MEDIUM_THRESHOLD = 500;

// ============================================================================
// SERVICE
// ============================================================================

export class BodyStateService {
  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
    private digitalBody?: DigitalBody,
  ) {}

  /**
   * Compute the full body state snapshot.
   */
  async getBodyState(): Promise<BodyState> {
    const [organs, agentPerformance, memory, pipeline, cost] = await Promise.all([
      this.getOrganStatuses(),
      this.getAgentPerformance(),
      this.getMemoryPressure(),
      this.getPipelineStatus(),
      this.getCostTrajectory(),
    ]);

    // Overall health: critical if any organ failed, degraded if any degraded
    let overallHealth: BodyState['overallHealth'] = 'healthy';
    if (organs.some(o => o.health === 'failed')) {
      overallHealth = 'critical';
    } else if (organs.some(o => o.health === 'degraded') || memory.pressure === 'high' || pipeline.failedLast24h > 5) {
      overallHealth = 'degraded';
    }

    return {
      overallHealth,
      organs,
      agentPerformance,
      memory,
      pipeline,
      cost,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Compact summary for system prompt injection (proprioceptive context).
   */
  async getProprioceptiveSummary(): Promise<string> {
    try {
      const state = await this.getBodyState();
      const lines: string[] = [];

      lines.push(`System health: ${state.overallHealth}`);

      // Active organs
      const active = state.organs.filter(o => o.active);
      const degraded = state.organs.filter(o => o.health === 'degraded' || o.health === 'failed');
      if (active.length > 0) {
        lines.push(`Active organs: ${active.map(o => o.name).join(', ')}`);
      }
      if (degraded.length > 0) {
        lines.push(`Degraded: ${degraded.map(o => `${o.name} (${o.health})`).join(', ')}`);
      }

      // Pipeline
      if (state.pipeline.pending > 0 || state.pipeline.inProgress > 0) {
        lines.push(`Pipeline: ${state.pipeline.inProgress} in progress, ${state.pipeline.pending} pending, ${state.pipeline.pendingApprovals} awaiting approval`);
      }
      if (state.pipeline.failedLast24h > 0) {
        lines.push(`Failures (24h): ${state.pipeline.failedLast24h}`);
      }

      // Memory pressure
      if (state.memory.pressure !== 'low') {
        lines.push(`Memory pressure: ${state.memory.pressure} (${state.memory.activeCount}/${state.memory.cap})`);
      }

      return lines.join('\n');
    } catch (err) {
      logger.debug({ err }, '[BodyState] Failed to build proprioceptive summary');
      return '';
    }
  }

  // --------------------------------------------------------------------------
  // INTERNAL QUERIES
  // --------------------------------------------------------------------------

  private async getOrganStatuses(): Promise<OrganStatus[]> {
    if (!this.digitalBody) return [];

    return this.digitalBody.getOrgans().map(organ => ({
      id: organ.id,
      name: organ.name,
      health: organ.getHealth(),
      active: organ.isActive(),
    }));
  }

  private async getAgentPerformance(): Promise<AgentPerformance[]> {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data: agents } = await this.db.from('agent_workforce_agents')
        .select('id, name')
        .eq('workspace_id', this.workspaceId);

      if (!agents || agents.length === 0) return [];

      const results: AgentPerformance[] = [];
      for (const agent of agents) {
        const a = agent as Record<string, unknown>;
        const agentId = a.id as string;

        // Both counters MUST use the same denominator cohort — "tasks
        // created in the last 24h" — or the numerator can exceed the
        // denominator when a task was created before the window but
        // completed inside it, producing absurd success rates like 267%.
        // P0.3 bench caught exactly that for Sentinel.
        const [completed, total] = await Promise.all([
          this.db.from('agent_workforce_tasks')
            .select('id', { count: 'exact', head: true })
            .eq('agent_id', agentId)
            .in('status', ['completed', 'approved'])
            .gte('created_at', oneDayAgo),
          this.db.from('agent_workforce_tasks')
            .select('id', { count: 'exact', head: true })
            .eq('agent_id', agentId)
            .gte('created_at', oneDayAgo),
        ]);

        const totalCount = total.count ?? 0;
        const completedCount = Math.min(completed.count ?? 0, totalCount);

        if (totalCount > 0) {
          results.push({
            agentId,
            agentName: a.name as string,
            recentSuccessRate: Math.round((completedCount / totalCount) * 100),
            tasksLast24h: totalCount,
          });
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  private async getMemoryPressure(): Promise<BodyState['memory']> {
    try {
      const { count } = await this.db.from('agent_workforce_agent_memory')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', this.workspaceId)
        .eq('is_active', 1);

      const activeCount = count ?? 0;
      let pressure: 'low' | 'medium' | 'high' = 'low';
      if (activeCount >= MEMORY_CAP) pressure = 'high';
      else if (activeCount >= MEMORY_MEDIUM_THRESHOLD) pressure = 'medium';

      return { activeCount, cap: MEMORY_CAP, pressure };
    } catch {
      return { activeCount: 0, cap: MEMORY_CAP, pressure: 'low' };
    }
  }

  private async getPipelineStatus(): Promise<BodyState['pipeline']> {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const [pending, inProgress, pendingApprovals, failed] = await Promise.all([
        this.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
          .eq('workspace_id', this.workspaceId).eq('status', 'pending'),
        this.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
          .eq('workspace_id', this.workspaceId).eq('status', 'in_progress'),
        this.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
          .eq('workspace_id', this.workspaceId).eq('status', 'needs_approval'),
        this.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
          .eq('workspace_id', this.workspaceId).eq('status', 'failed')
          .gte('completed_at', oneDayAgo),
      ]);

      return {
        pending: pending.count ?? 0,
        inProgress: inProgress.count ?? 0,
        pendingApprovals: pendingApprovals.count ?? 0,
        failedLast24h: failed.count ?? 0,
      };
    } catch {
      return { pending: 0, inProgress: 0, pendingApprovals: 0, failedLast24h: 0 };
    }
  }

  private async getCostTrajectory(): Promise<BodyState['cost']> {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [{ data: day }, { data: week }] = await Promise.all([
        this.db.from('agent_workforce_tasks')
          .select('cost_cents')
          .eq('workspace_id', this.workspaceId)
          .gte('completed_at', oneDayAgo),
        this.db.from('agent_workforce_tasks')
          .select('cost_cents')
          .eq('workspace_id', this.workspaceId)
          .gte('completed_at', sevenDaysAgo),
      ]);

      const sum = (rows: unknown[] | null): number =>
        (rows ?? []).reduce<number>((acc, r) => acc + ((r as Record<string, unknown>).cost_cents as number || 0), 0);

      return {
        last24hCents: sum(day),
        last7dCents: sum(week),
      };
    } catch {
      return { last24hCents: 0, last7dCents: 0 };
    }
  }
}
