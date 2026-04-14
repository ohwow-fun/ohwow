/**
 * ContentCadenceScheduler — closes the business loop for
 * ContentCadenceTunerExperiment.
 *
 * Every hour this scheduler:
 *   1. Ensures the x_posts_per_week goal row exists (INSERT OR IGNORE).
 *   2. Reads content_cadence.posts_per_day from runtime_config_overrides
 *      (falls back to DEFAULT 1 when no override is set).
 *   3. Counts X posts completed so far today (agent_workforce_tasks WHERE
 *      x_compose metadata is set AND status='completed' AND completed_at >= today).
 *   4. If still under budget, finds an X-capable agent and dispatches a
 *      "post one tweet today" task.
 *   5. Counts X posts in the trailing 7 days and updates the goal's
 *      current_value so ContentCadenceTunerExperiment.validate() sees real
 *      signal when it re-reads the goal 24 hours after a knob widening.
 *
 * Why this lives in src/scheduling/ and not in src/self-bench/
 * ---------------------------------------------------------------
 * This is an outbound action scheduler, not a probe/judge/intervene loop.
 * It belongs alongside LocalScheduler and ImprovementScheduler — services
 * that drive real work at a cadence — rather than inside the self-bench
 * experiment runner, which exclusively observes and proposes.
 *
 * Workspace guard
 * ---------------
 * The scheduler is only instantiated in daemon/start.ts when
 * workspaceSlug === 'default'. ContentCadenceTunerExperiment enforces the
 * same guard via BusinessExperiment.probe(). Belt-and-braces: one guard in
 * the scheduler, one in the experiment.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { RuntimeEngine } from '../execution/engine.js';
import { logger } from '../lib/logger.js';
import { getRuntimeConfig } from '../self-bench/runtime-config.js';
import {
  CONTENT_CADENCE_CONFIG_KEY,
  CONTENT_CADENCE_DEFAULT,
} from '../self-bench/experiments/content-cadence-tuner.js';

/** Goal row id used for INSERT OR IGNORE. Stable across restarts. */
const GOAL_ID = 'goal-x-posts-per-week';

/** target_metric string the ContentCadenceTunerExperiment anchors on. */
const GOAL_METRIC = 'x_posts_per_week';

/** Trailing window for weekly count. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Default tick interval — every hour. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export class ContentCadenceScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private executing = false;

  constructor(
    private db: DatabaseAdapter,
    private engine: RuntimeEngine,
    private workspaceId: string,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    // Fire once immediately (don't wait a full hour on daemon boot).
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    logger.info({ intervalMs }, '[ContentCadenceScheduler] started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('[ContentCadenceScheduler] stopped');
  }

  /**
   * Single tick of the budget loop. Public for integration tests
   * that drive ticks directly instead of waiting on the interval.
   * Production callers go through start()/stop() — do not call this
   * directly from app code.
   */
  async tick(): Promise<void> {
    if (this.executing) return; // skip overlapping ticks
    this.executing = true;
    try {
      await this.ensureGoalExists();

      const postsPerDay = getRuntimeConfig<number>(CONTENT_CADENCE_CONFIG_KEY, CONTENT_CADENCE_DEFAULT);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const postsToday = await this.countXPostsAfter(todayStart.toISOString());

      logger.debug(
        { postsPerDay, postsToday },
        '[ContentCadenceScheduler] daily budget check',
      );

      if (postsToday < postsPerDay) {
        const agentId = await this.findXAgent();
        if (agentId) {
          // Backlog guard: don't pile up duplicate work. If this agent already
          // has tweet tasks awaiting approval, defer until they drain. Without
          // this, the scheduler can pile up 15+ near-duplicate pending tasks.
          const pending = await this.countPendingApprovalsForAgent(agentId);
          if (pending >= 3) {
            logger.info(
              { agentId, pending },
              '[ContentCadenceScheduler] pending approval backlog — skipping dispatch',
            );
          } else {
            await this.dispatchXPostTask(agentId);
          }
        } else {
          logger.warn(
            { workspaceId: this.workspaceId },
            '[ContentCadenceScheduler] no idle agent found — skipping dispatch',
          );
        }
      }

      const weekStart = new Date(Date.now() - WEEK_MS);
      const postsThisWeek = await this.countXPostsAfter(weekStart.toISOString());
      await this.updateWeeklyGoalValue(postsThisWeek);
    } catch (err) {
      logger.error({ err }, '[ContentCadenceScheduler] tick failed');
    } finally {
      this.executing = false;
    }
  }

  /**
   * Seed the x_posts_per_week goal row if it doesn't already exist.
   * Uses the workspaceId from constructor — correctly bound after
   * daemon runtime consolidation, unlike a migration-time slug lookup.
   */
  private async ensureGoalExists(): Promise<void> {
    try {
      const { data } = await this.db
        .from<{ id: string; due_date: string | null }>('agent_workforce_goals')
        .select('id, due_date')
        .eq('id', GOAL_ID);
      const rows = (data ?? []) as Array<{ id: string; due_date: string | null }>;

      // Roll the deadline forward when the existing goal is within 1 day of
      // (or past) its due_date. Without this refresh, the 7-day window the
      // probe needs collapses on day 8 — computeRequiredVelocity returns null
      // for past-due goals, the judge falls into goal_met_or_past_due, and
      // the tuner stops having a velocity gap to react to. Rolling forward
      // weekly keeps the rate the metric name promises (posts/week) honest.
      if (rows.length > 0) {
        const existing = rows[0];
        const ROLL_FORWARD_THRESHOLD_MS = 24 * 60 * 60 * 1000;
        const dueMs = existing.due_date ? new Date(existing.due_date).getTime() : 0;
        if (dueMs - Date.now() < ROLL_FORWARD_THRESHOLD_MS) {
          const nextDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
          nextDue.setHours(0, 0, 0, 0);
          await this.db
            .from('agent_workforce_goals')
            .update({
              due_date: nextDue.toISOString().split('T')[0],
              updated_at: new Date().toISOString(),
            })
            .eq('id', GOAL_ID);
          logger.info(
            { goalId: GOAL_ID, nextDue: nextDue.toISOString().split('T')[0] },
            '[ContentCadenceScheduler] rolled x_posts_per_week goal forward 7 days',
          );
        }
        return;
      }

      const now = new Date().toISOString();
      // 7 posts over 7 days = 1 post/day required velocity. The tuner's
      // probe computes requiredPerDay = (target - current) / daysRemaining,
      // so target_value and due_date must agree on the rate the goal name
      // promises. A 7-post target across a 90-day window collapses to
      // 0.078/day — trivially met by the default cadence (1/day) — and
      // the tuner would never have a reason to widen.
      const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      due.setHours(0, 0, 0, 0);

      await this.db.from('agent_workforce_goals').insert({
        id: GOAL_ID,
        workspace_id: this.workspaceId,
        title: 'X posts per week',
        description:
          'Post 7 times this week on X to maintain top-of-funnel cadence. ' +
          'Refreshed weekly — current_value is the trailing-7d post count.',
        target_metric: GOAL_METRIC,
        target_value: 7.0,
        current_value: 0.0,
        unit: 'posts/week',
        status: 'active',
        priority: 'high',
        due_date: due.toISOString().split('T')[0],
        color: '#1DA1F2',
        icon: null,
        position: 0,
        created_at: now,
        updated_at: now,
      });

      logger.info(
        { goalId: GOAL_ID, workspaceId: this.workspaceId },
        '[ContentCadenceScheduler] seeded x_posts_per_week goal',
      );
    } catch (err) {
      // Non-fatal — a duplicate key from a concurrent insert is fine.
      logger.debug({ err }, '[ContentCadenceScheduler] ensureGoalExists error (likely race, ignored)');
    }
  }

  /**
   * Count agent_workforce_tasks that:
   *   - belong to this workspace
   *   - have status='completed'
   *   - have completed_at >= since (ISO string)
   *   - have metadata that indicates an x_compose tool was used
   *     (posted_via: 'x_compose_tweet', 'x_compose_thread', or 'x_compose_article')
   */
  private async countXPostsAfter(since: string): Promise<number> {
    try {
      // The metadata column is JSON TEXT. SQLite's json_extract lets us
      // filter; the DatabaseAdapter .from() chain doesn't expose raw SQL,
      // so we fetch recently-completed tasks and filter in JS.
      // In practice the window is ≤168 tasks (7 days × up to 24/day at max
      // cadence), so in-process filtering is fine here.
      const { data } = await this.db
        .from<{ id: string; metadata: string | null; completed_at: string | null }>('agent_workforce_tasks')
        .select('id, metadata, completed_at')
        .eq('workspace_id', this.workspaceId)
        .eq('status', 'completed');

      const rows = (data ?? []) as Array<{
        id: string;
        metadata: string | null;
        completed_at: string | null;
      }>;

      return rows.filter((r) => {
        if (!r.completed_at || r.completed_at < since) return false;
        const meta = parseMetadata(r.metadata);
        const via = meta.posted_via as string | undefined;
        return typeof via === 'string' && via.startsWith('x_compose');
      }).length;
    } catch (err) {
      logger.warn({ err, since }, '[ContentCadenceScheduler] countXPostsAfter failed');
      return 0;
    }
  }

  /**
   * How many tasks for this agent are currently parked in needs_approval.
   * Used as a backlog guard: if the queue is already long, deferring the next
   * dispatch beats piling up near-duplicate drafts the human never gets through.
   */
  private async countPendingApprovalsForAgent(agentId: string): Promise<number> {
    try {
      const { count } = await this.db
        .from('agent_workforce_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', this.workspaceId)
        .eq('agent_id', agentId)
        .eq('status', 'needs_approval');
      return count ?? 0;
    } catch (err) {
      logger.warn({ err, agentId }, '[ContentCadenceScheduler] countPendingApprovalsForAgent failed');
      return 0;
    }
  }

  /**
   * Find an agent to delegate the X post task to.
   * Prefers agents whose names suggest social/content specialty;
   * falls back to any idle agent in this workspace.
   *
   * Filters on status='idle' because that's the "available to receive
   * work" state in the agent lifecycle. The earlier 'active' filter
   * never matched any row — agents transition between 'idle' (ready)
   * and 'working' (executing a task), with no 'active' enum value.
   * Cross-check: agent-lock-contention.ts joins on status='working'
   * for the executing semantic; the inverse here is 'idle'.
   */
  private async findXAgent(): Promise<string | null> {
    try {
      const { data } = await this.db
        .from<{ id: string; name: string }>('agent_workforce_agents')
        .select('id, name')
        .eq('workspace_id', this.workspaceId)
        .eq('status', 'idle');

      const agents = (data ?? []) as Array<{ id: string; name: string }>;
      if (agents.length === 0) return null;

      // Prefer social/content/post-focused agents.
      const contentKeywords = ['social', 'content', 'post', 'twitter', 'x '];
      const preferred = agents.find((a) =>
        contentKeywords.some((kw) => a.name.toLowerCase().includes(kw)),
      );
      return preferred?.id ?? agents[0]?.id ?? null;
    } catch (err) {
      logger.warn({ err }, '[ContentCadenceScheduler] findXAgent failed');
      return null;
    }
  }

  /**
   * Insert a pending task for the given agent and immediately kick off
   * execution via the runtime engine. Mirrors local-scheduler.ts fireSchedule.
   */
  private async dispatchXPostTask(agentId: string): Promise<void> {
    try {
      const prompt =
        'Write and post one original tweet. Keep it concise (under 280 characters), ' +
        'on-brand, and relevant to our current work or industry. Do not ask for approval — just post it.';

      // trust_output: tell task-completion.ts we don't want an approval gate on
      // this dispatch; the prompt already says "just post it". This short-circuits
      // the L<=2 + deliverable → needs_approval routing that was piling up 15+
      // duplicate pending rows per day.
      //
      // deferred_action: declare the intended real-world action so
      // DeliverableExecutor can actually post the tweet once the agent produces
      // one. Executor defaults to dry-run unless runtime_settings.
      // deliverable_executor_live is flipped to "true".
      const { data: taskData } = await this.db
        .from('agent_workforce_tasks')
        .insert({
          workspace_id: this.workspaceId,
          agent_id: agentId,
          title: 'Post one tweet today',
          input: prompt,
          status: 'pending',
          priority: 'normal',
          metadata: JSON.stringify({ trust_output: true, dispatcher: 'content_cadence' }),
          deferred_action: JSON.stringify({ type: 'post_tweet', provider: 'x', params: {} }),
        })
        .select('id')
        .single();

      if (!taskData) {
        logger.warn({ agentId }, '[ContentCadenceScheduler] task insert returned no id');
        return;
      }

      const taskId = (taskData as { id: string }).id;

      // Fire-and-forget — engine reports results through the task + ledger.
      this.engine.executeTask(agentId, taskId).catch((err: unknown) => {
        logger.error({ err, agentId, taskId }, '[ContentCadenceScheduler] task execution failed');
      });

      logger.info(
        { agentId, taskId },
        '[ContentCadenceScheduler] dispatched X post task',
      );
    } catch (err) {
      logger.error({ err, agentId }, '[ContentCadenceScheduler] dispatchXPostTask failed');
    }
  }

  /**
   * Update the goal's current_value to the current trailing-7d X post count.
   * This is the signal ContentCadenceTunerExperiment.validate() reads when
   * deciding whether a knob widening moved the needle.
   */
  private async updateWeeklyGoalValue(count: number): Promise<void> {
    try {
      await this.db
        .from('agent_workforce_goals')
        .update({
          current_value: count,
          updated_at: new Date().toISOString(),
        })
        .eq('id', GOAL_ID);
    } catch (err) {
      logger.warn({ err, count }, '[ContentCadenceScheduler] updateWeeklyGoalValue failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
