/**
 * Inner Thoughts Loop — Background Context Accumulation
 *
 * "Consciousness is not a thing but a process."
 * — Alfred North Whitehead
 *
 * While the user is away, the agent continuously gathers context:
 * pending tasks, recent completions, overnight activity, anomalies.
 * A small model distills each context snapshot into a single salient
 * thought. When the user arrives, these thoughts feed the greeting
 * assembler so the greeting is warm and contextually rich, not cold-start.
 *
 * Inspired by:
 * - "Proactive Conversational Agents with Inner Thoughts" (arxiv 2501.00383)
 * - LLAMAPIE small-model gate pattern (arxiv 2505.04066)
 */

import { randomUUID } from 'crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { GlobalWorkspace } from '../brain/global-workspace.js';
import type { ModelRouter } from '../execution/model-router.js';
import type { ContextSnapshot, ThoughtEntry } from './types.js';
import { getFleetSensingData } from '../lib/device-info.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum thoughts kept in the rolling window. */
const MAX_THOUGHTS = 20;

/** Default interval when user is active (5 min). */
const ACTIVE_INTERVAL_MS = 5 * 60 * 1000;

/** Faster interval when user is away, preparing for arrival (2 min). */
const AWAY_INTERVAL_MS = 2 * 60 * 1000;

/** How far back to look for recent completions. */
const RECENT_WINDOW_MS = 8 * 60 * 60 * 1000; // 8 hours

/** How far back to look for overnight activity. */
const OVERNIGHT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// INNER THOUGHTS LOOP
// ============================================================================

export class InnerThoughtsLoop {
  private thoughts: ThoughtEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastUserActive = true;

  constructor(
    private db: DatabaseAdapter,
    private workspace: GlobalWorkspace,
    private modelRouter: ModelRouter,
    private workspaceId: string,
  ) {}

  // --------------------------------------------------------------------------
  // LIFECYCLE
  // --------------------------------------------------------------------------

  start(intervalMs = ACTIVE_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;

    // Run immediately, then on interval
    this.tick().catch(err => {
      logger.warn(`[InnerThoughts] Initial tick failed: ${err instanceof Error ? err.message : err}`);
    });

    this.timer = setInterval(() => {
      this.tick().catch(err => {
        logger.warn(`[InnerThoughts] Tick failed: ${err instanceof Error ? err.message : err}`);
      });
    }, intervalMs);

    logger.info('[InnerThoughts] Started background context loop');
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('[InnerThoughts] Stopped');
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /** Get the top N most salient thoughts, sorted by salience descending. */
  getThoughts(limit = 5): ThoughtEntry[] {
    return [...this.thoughts]
      .sort((a, b) => b.salience - a.salience)
      .slice(0, limit);
  }

  /** Clear all thoughts (e.g., after greeting was delivered). */
  clearThoughts(): void {
    this.thoughts = [];
  }

  /** Check if the loop is running. */
  get isRunning(): boolean {
    return this.running;
  }

  // --------------------------------------------------------------------------
  // CORE LOOP
  // --------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.running) return;

    // Adjust interval based on user presence
    const sensing = await getFleetSensingData();
    const userActive = sensing.userActive ?? true;

    if (userActive !== this.lastUserActive) {
      this.lastUserActive = userActive;
      // User went away → speed up context gathering
      if (!userActive && this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => {
          this.tick().catch(() => {});
        }, AWAY_INTERVAL_MS);
        logger.debug('[InnerThoughts] User away, switching to fast interval');
      }
      // User came back → slow down (presence engine handles the greeting now)
      if (userActive && this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => {
          this.tick().catch(() => {});
        }, ACTIVE_INTERVAL_MS);
        logger.debug('[InnerThoughts] User active, switching to normal interval');
      }
    }

    try {
      const snapshot = await this.gatherContext();
      const thought = await this.distill(snapshot);

      if (thought) {
        this.addThought(thought);
        this.broadcastThought(thought);
      }
    } catch (err) {
      logger.debug(`[InnerThoughts] Gather/distill error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // --------------------------------------------------------------------------
  // CONTEXT GATHERING
  // --------------------------------------------------------------------------

  async gatherContext(): Promise<ContextSnapshot> {
    const now = new Date();
    const recentCutoff = new Date(now.getTime() - RECENT_WINDOW_MS).toISOString();
    const overnightCutoff = new Date(now.getTime() - OVERNIGHT_WINDOW_MS).toISOString();

    // Query pending tasks with agent names
    const { data: pendingTaskRows } = await this.db
      .from('agent_workforce_tasks')
      .select('id, title, agent_id, priority')
      .eq('workspace_id', this.workspaceId)
      .in('status', ['pending', 'needs_approval'])
      .order('created_at', { ascending: false })
      .limit(10);

    // Query recent completions
    const { data: completionRows } = await this.db
      .from('agent_workforce_tasks')
      .select('title, agent_id, completed_at')
      .eq('workspace_id', this.workspaceId)
      .in('status', ['completed', 'approved'])
      .gte('completed_at', recentCutoff)
      .order('completed_at', { ascending: false })
      .limit(10);

    // Query overnight activity counts
    const [overnightCompleted, overnightStarted, overnightFailed] = await Promise.all([
      this.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
        .eq('workspace_id', this.workspaceId).in('status', ['completed', 'approved']).gte('completed_at', overnightCutoff),
      this.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
        .eq('workspace_id', this.workspaceId).gte('created_at', overnightCutoff),
      this.db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
        .eq('workspace_id', this.workspaceId).eq('status', 'failed').gte('completed_at', overnightCutoff),
    ]);

    // Get agent name map
    const { data: agentRows } = await this.db
      .from('agent_workforce_agents')
      .select('id, name')
      .eq('workspace_id', this.workspaceId);

    const agentNameMap = new Map<string, string>();
    if (agentRows) {
      for (const a of agentRows as Array<{ id: string; name: string }>) {
        agentNameMap.set(a.id, a.name);
      }
    }

    // Fleet sensing for idle time
    const sensing = await getFleetSensingData();
    const userIdleMs = sensing.userActive ? 0 : 300_000; // Rough: 5min if not active

    const hour = now.getHours();
    const timeOfDay: ContextSnapshot['timeOfDay'] =
      hour < 12 ? 'morning' :
      hour < 17 ? 'afternoon' :
      hour < 21 ? 'evening' : 'night';

    const pendingTasks = ((pendingTaskRows || []) as Array<Record<string, unknown>>).map(t => ({
      id: t.id as string,
      title: t.title as string,
      agentName: agentNameMap.get(t.agent_id as string) || 'Unknown',
      priority: t.priority as string | undefined,
    }));

    const recentCompletions = ((completionRows || []) as Array<Record<string, unknown>>).map(t => ({
      title: t.title as string,
      agentName: agentNameMap.get(t.agent_id as string) || 'Unknown',
      completedAt: t.completed_at as string,
    }));

    return {
      pendingTasks,
      recentCompletions,
      unreadMessages: [], // TODO: Wire when channel message storage is implemented
      overnightActivity: {
        tasksCompleted: overnightCompleted.count ?? 0,
        tasksStarted: overnightStarted.count ?? 0,
        errors: overnightFailed.count ?? 0,
      },
      userIdleMs,
      timeOfDay,
    };
  }

  // --------------------------------------------------------------------------
  // DISTILLATION — Small model produces a single thought
  // --------------------------------------------------------------------------

  private async distill(snapshot: ContextSnapshot): Promise<ThoughtEntry | null> {
    // Skip if there's nothing interesting
    const hasPending = snapshot.pendingTasks.length > 0;
    const hasCompletions = snapshot.recentCompletions.length > 0;
    const hasErrors = snapshot.overnightActivity.errors > 0;
    const hasActivity = snapshot.overnightActivity.tasksCompleted > 0;

    if (!hasPending && !hasCompletions && !hasErrors && !hasActivity) {
      return null;
    }

    // Build a compact context string for the model
    const parts: string[] = [];

    if (snapshot.pendingTasks.length > 0) {
      const taskList = snapshot.pendingTasks.slice(0, 5).map(t =>
        `- "${t.title}" (${t.agentName}${t.priority ? `, ${t.priority}` : ''})`
      ).join('\n');
      parts.push(`Pending tasks:\n${taskList}`);
    }

    if (snapshot.recentCompletions.length > 0) {
      const completionList = snapshot.recentCompletions.slice(0, 5).map(t =>
        `- "${t.title}" completed by ${t.agentName}`
      ).join('\n');
      parts.push(`Recent completions:\n${completionList}`);
    }

    if (hasErrors) {
      parts.push(`Overnight errors: ${snapshot.overnightActivity.errors} tasks failed.`);
    }

    parts.push(`Time: ${snapshot.timeOfDay}. Tasks completed overnight: ${snapshot.overnightActivity.tasksCompleted}.`);

    const prompt = `You are an AI assistant's inner monologue. Given the current workspace state, produce ONE brief thought (1-2 sentences) about the most noteworthy thing happening. Focus on what the user would care about most when they sit down.

Context:
${parts.join('\n\n')}

Respond with ONLY the thought, no preamble.`;

    try {
      const provider = await this.modelRouter.getProvider('orchestrator');
      const result = await provider.createMessage({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 100,
        temperature: 0.3,
      });

      const content = result.content.trim();

      if (!content) return null;

      // Determine category and salience
      let category: ThoughtEntry['category'] = 'insight';
      let salience = 0.5;

      if (hasErrors) {
        category = 'anomaly';
        salience = 0.9;
      } else if (snapshot.pendingTasks.some(t => t.priority === 'urgent' || t.priority === 'high')) {
        category = 'task';
        salience = 0.8;
      } else if (snapshot.recentCompletions.length >= 3) {
        category = 'agent_activity';
        salience = 0.6;
      } else if (hasPending) {
        category = 'task';
        salience = 0.5;
      }

      return {
        id: randomUUID(),
        content,
        category,
        salience,
        timestamp: Date.now(),
        sourceData: {
          pendingCount: snapshot.pendingTasks.length,
          completionCount: snapshot.recentCompletions.length,
          errorCount: snapshot.overnightActivity.errors,
        },
      };
    } catch (err) {
      logger.debug(`[InnerThoughts] Distill LLM call failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private addThought(thought: ThoughtEntry): void {
    this.thoughts.push(thought);

    // Enforce rolling window
    if (this.thoughts.length > MAX_THOUGHTS) {
      // Remove least salient
      this.thoughts.sort((a, b) => a.salience - b.salience);
      this.thoughts.shift();
    }

    logger.debug(
      { category: thought.category, salience: thought.salience },
      `[InnerThoughts] New thought: ${thought.content.slice(0, 80)}`,
    );
  }

  private broadcastThought(thought: ThoughtEntry): void {
    this.workspace.broadcastSignal(
      'inner_thoughts',
      thought.content,
      thought.salience * 0.6, // Dampen: inner thoughts are less salient than direct signals
    );
  }
}
