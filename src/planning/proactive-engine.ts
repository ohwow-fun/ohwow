/**
 * ProactiveEngine — Generates nudges by checking for actionable situations.
 *
 * Runs periodically (every 30 minutes) alongside the heartbeat.
 * Checks: overdue tasks, aging approvals, idle agents.
 * Generates nudges stored in agent_workforce_nudges table.
 * Does NOT auto-execute. Suggestions only, user acts or dismisses.
 */

import type { TypedEventBus } from '../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../tui/types.js';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

interface NudgeInsert {
  workspace_id: string;
  nudge_type: string;
  title: string;
  description: string;
  suggested_action: string;
}

/** Dedup key: nudge_type + entity_id */
interface RecentNudge {
  key: string;
  at: number;
}

const DEDUP_WINDOW_MS = 5 * 60_000; // 5 minutes

export class ProactiveEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private emitter: TypedEventBus<RuntimeEvents> | null;

  get isRunning(): boolean {
    return this.running;
  }
  private recentNudges: RecentNudge[] = [];
  private lastGapCheckAt = 0;

  constructor(
    private db: DatabaseAdapter,
    private workspaceId: string,
    emitter?: TypedEventBus<RuntimeEvents>,
  ) {
    this.emitter = emitter ?? null;
  }

  /** Start checking every 30 minutes + listen to events for immediate nudges */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Register event listeners for immediate nudges
    if (this.emitter) {
      this.emitter.on('task:failed', this.onTaskFailed);
      this.emitter.on('task:needs_approval', this.onTaskNeedsApproval);
      this.emitter.on('task:completed', this.onTaskCompleted);
    }

    // Run once on startup
    await this.check();

    this.timer = setInterval(() => {
      this.check().catch((err) => {
        logger.error({ err }, '[ProactiveEngine] Check error');
      });
    }, 30 * 60_000); // 30 minutes
  }

  /** Stop the proactive engine */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.emitter) {
      this.emitter.off('task:failed', this.onTaskFailed);
      this.emitter.off('task:needs_approval', this.onTaskNeedsApproval);
      this.emitter.off('task:completed', this.onTaskCompleted);
    }
  }

  // ==========================================================================
  // EVENT HANDLERS (immediate nudges)
  // ==========================================================================

  private onTaskFailed = (data: { taskId: string; agentId: string; error: string }): void => {
    this.insertEventNudge('task_failed', data.taskId, {
      nudge_type: 'task_failed',
      title: 'A task just failed',
      description: `Task ${data.taskId} encountered an error: ${(data.error || '').slice(0, 120)}`,
      suggested_action: `Retry or reassign task ${data.taskId}`,
    });
  };

  private onTaskNeedsApproval = (data: { taskId: string; agentName?: string; taskTitle?: string }): void => {
    const label = data.agentName && data.taskTitle
      ? `${data.agentName} needs review on "${data.taskTitle}"`
      : 'An agent needs your review';
    this.insertEventNudge('needs_approval', data.taskId, {
      nudge_type: 'needs_approval',
      title: label,
      description: 'Review and approve or reject the output to keep things moving.',
      suggested_action: 'Go to the Approvals tab',
    });
  };

  private onTaskCompleted = (data: { taskId: string; agentId: string; status: string }): void => {
    if (data.status !== 'completed') return;
    // Check if this agent is now idle with no pending work
    this.checkIdleAfterCompletion(data.agentId).catch(() => {});
  };

  private async checkIdleAfterCompletion(agentId: string): Promise<void> {
    const { count } = await this.db
      .from('agent_workforce_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId)
      .in('status', ['pending', 'in_progress']);

    if (count === 0) {
      const { data: agentData } = await this.db
        .from('agent_workforce_agents')
        .select('name')
        .eq('id', agentId)
        .single();
      const name = (agentData as { name: string } | null)?.name || 'An agent';
      this.insertEventNudge('idle_after_completion', agentId, {
        nudge_type: 'idle_agent',
        title: `${name} just finished and has nothing queued`,
        description: `${name} is idle. Give them another task to keep momentum.`,
        suggested_action: 'Assign work from the Chat tab',
      });
    }
  }

  /** Insert a nudge with dedup protection */
  private insertEventNudge(
    type: string,
    entityId: string,
    nudge: Omit<NudgeInsert, 'workspace_id'>,
  ): void {
    const key = `${type}:${entityId}`;
    const now = Date.now();

    // Prune old entries
    this.recentNudges = this.recentNudges.filter((r) => now - r.at < DEDUP_WINDOW_MS);

    // Skip if duplicate within window
    if (this.recentNudges.some((r) => r.key === key)) return;

    this.recentNudges.push({ key, at: now });

    this.db.from('agent_workforce_nudges').insert({
      workspace_id: this.workspaceId,
      ...nudge,
    }).then(() => {}, (err) => {
      logger.error({ err }, '[ProactiveEngine] Event nudge insert failed');
    });
  }

  /**
   * Run all proactive checks and generate nudges.
   */
  private async check(): Promise<void> {
    // Clear old active nudges before generating new ones
    await this.db.from('agent_workforce_nudges')
      .update({ status: 'dismissed', updated_at: new Date().toISOString() })
      .eq('workspace_id', this.workspaceId)
      .eq('status', 'active');

    const nudges: NudgeInsert[] = [];

    await Promise.all([
      this.checkOverdueTasks(nudges),
      this.checkAgingApprovals(nudges),
      this.checkIdleAgents(nudges),
      this.checkAgentGaps(),
    ]);

    // Insert new nudges (max 5 to avoid noise)
    for (const nudge of nudges.slice(0, 5)) {
      await this.db.from('agent_workforce_nudges').insert({ ...nudge });
    }
  }

  /**
   * Check for tasks that have been in_progress for over 30 minutes.
   */
  private async checkOverdueTasks(nudges: NudgeInsert[]): Promise<void> {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();

    const { data } = await this.db
      .from('agent_workforce_tasks')
      .select('id, title, started_at')
      .eq('workspace_id', this.workspaceId)
      .eq('status', 'in_progress')
      .lt('started_at', thirtyMinAgo)
      .limit(3);

    if (!data) return;
    const tasks = data as Array<{ id: string; title: string; started_at: string }>;

    for (const task of tasks) {
      nudges.push({
        workspace_id: this.workspaceId,
        nudge_type: 'overdue_task',
        title: `Task running longer than expected: ${task.title}`,
        description: `Started at ${task.started_at}. It may be stuck.`,
        suggested_action: `Check task ${task.id} or cancel it`,
      });
    }
  }

  /**
   * Check for approvals that have been waiting for over 2 hours.
   */
  private async checkAgingApprovals(nudges: NudgeInsert[]): Promise<void> {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();

    const { count } = await this.db
      .from('agent_workforce_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', this.workspaceId)
      .eq('status', 'needs_approval')
      .lt('completed_at', twoHoursAgo);

    if (count && count > 0) {
      nudges.push({
        workspace_id: this.workspaceId,
        nudge_type: 'aging_approval',
        title: `${count} approval${count === 1 ? '' : 's'} waiting for over 2 hours`,
        description: 'Review and approve or reject pending work to keep things moving.',
        suggested_action: 'Go to the Approvals tab',
      });
    }
  }

  /**
   * Check for agent team gaps (24h throttle).
   * Runs the gap analyzer and creates nudges for new suggestions.
   */
  private async checkAgentGaps(): Promise<void> {
    const GAP_CHECK_INTERVAL_MS = 24 * 60 * 60_000; // 24 hours
    const now = Date.now();
    if (now - this.lastGapCheckAt < GAP_CHECK_INTERVAL_MS) return;
    this.lastGapCheckAt = now;

    try {
      const { runLocalGapAnalysis, saveLocalSuggestions } = await import('./agent-gap-analyzer.js');
      const suggestions = await runLocalGapAnalysis(this.db, this.workspaceId);
      if (suggestions.length === 0) return;

      await saveLocalSuggestions(this.db, this.workspaceId, suggestions);

      // Create a nudge for the first suggestion
      const first = suggestions[0];
      await this.db.from('agent_workforce_nudges').insert({
        workspace_id: this.workspaceId,
        nudge_type: 'agent_suggestion',
        title: first.title,
        description: first.reason,
        suggested_action: 'Check the Team page for new agent recommendations',
      });
    } catch (err) {
      logger.error({ err }, '[ProactiveEngine] Gap analysis error');
    }
  }

  /**
   * Check for agents that haven't run any tasks today.
   */
  private async checkIdleAgents(nudges: NudgeInsert[]): Promise<void> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: agents } = await this.db
      .from('agent_workforce_agents')
      .select('id, name')
      .eq('workspace_id', this.workspaceId)
      .eq('status', 'idle');

    if (!agents) return;
    const agentList = agents as Array<{ id: string; name: string }>;
    if (agentList.length === 0) return;

    // Check which agents have tasks today
    const agentIds = agentList.map((a) => a.id);
    const { data: activeTasks } = await this.db
      .from('agent_workforce_tasks')
      .select('agent_id')
      .in('agent_id', agentIds)
      .gte('created_at', todayStart.toISOString());

    const activeAgentIds = new Set(
      ((activeTasks || []) as Array<{ agent_id: string }>).map((t) => t.agent_id),
    );

    const idleAgents = agentList.filter((a) => !activeAgentIds.has(a.id));
    if (idleAgents.length > 0) {
      const names = idleAgents.slice(0, 3).map((a) => a.name).join(', ');
      nudges.push({
        workspace_id: this.workspaceId,
        nudge_type: 'idle_agent',
        title: `${idleAgents.length} agent${idleAgents.length === 1 ? ' has' : 's have'} no tasks today`,
        description: `${names}${idleAgents.length > 3 ? '...' : ''} could be doing work.`,
        suggested_action: 'Give them something to do from the Chat tab',
      });
    }
  }

}
