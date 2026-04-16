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
import { withCdpLane } from '../execution/browser/cdp-lane.js';
import type { RuntimeEngine } from '../execution/engine.js';
import { logger } from '../lib/logger.js';
import { getRuntimeConfig } from '../self-bench/runtime-config.js';
import {
  CONTENT_CADENCE_CONFIG_KEY,
  CONTENT_CADENCE_DEFAULT,
} from '../self-bench/experiments/content-cadence-tuner.js';
import { DeliverableExecutor } from '../execution/deliverable-executor.js';
import {
  selectApprovedDraft,
  markDraftConsumed,
  type ApprovedDraft,
} from './approved-draft-queue.js';

/** Goal row id used for INSERT OR IGNORE. Stable across restarts. */
const GOAL_ID = 'goal-x-posts-per-week';

/** target_metric string the ContentCadenceTunerExperiment anchors on. */
const GOAL_METRIC = 'x_posts_per_week';

/** Trailing window for weekly count. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Default tick interval — every hour. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface ContentCadenceSchedulerOptions {
  /**
   * Absolute path to the workspace's `x-approvals.jsonl` ledger. When
   * provided, the dispatcher checks the ledger for an approved, not-
   * yet-posted X draft BEFORE asking an agent to author one, and
   * posts the operator-approved text via the deliverable executor
   * with zero LLM iterations. This is the bypass path that kills
   * the "## Tweet Ready for Manual Posting" capitulation class.
   *
   * Omitted in tests that don't care about the bypass, and in
   * workspaces whose data dir doesn't exist yet.
   */
  approvalsJsonlPath?: string;
  /**
   * Override the deliverable executor. Tests inject a fake; prod
   * constructs one from the db on first use.
   */
  deliverableExecutor?: DeliverableExecutor;
}

export class ContentCadenceScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private executing = false;
  private readonly options: ContentCadenceSchedulerOptions;
  private cachedExecutor: DeliverableExecutor | null = null;

  constructor(
    private db: DatabaseAdapter,
    private engine: RuntimeEngine,
    private workspaceId: string,
    options: ContentCadenceSchedulerOptions = {},
  ) {
    this.options = options;
  }

  private getExecutor(): DeliverableExecutor {
    if (this.options.deliverableExecutor) return this.options.deliverableExecutor;
    if (!this.cachedExecutor) this.cachedExecutor = new DeliverableExecutor(this.db);
    return this.cachedExecutor;
  }

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
      // Count deliverables that actually landed on X (provider='x',
      // status='delivered'). This is the authoritative signal for "a post
      // happened" — before, the counter keyed on task.metadata.posted_via
      // which nothing in the new DeliverableExecutor flow ever sets, so
      // the goal meter stayed at 0 even after real posts went live.
      const { data } = await this.db
        .from<{ id: string; delivered_at: string | null; provider: string | null; status: string }>('agent_workforce_deliverables')
        .select('id, delivered_at, provider, status')
        .eq('workspace_id', this.workspaceId)
        .eq('status', 'delivered')
        .eq('provider', 'x');

      const rows = (data ?? []) as Array<{ delivered_at: string | null }>;
      return rows.filter((r) => !!r.delivered_at && r.delivered_at >= since).length;
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
        .from<{ id: string; name: string; role: string | null }>('agent_workforce_agents')
        .select('id, name, role')
        .eq('workspace_id', this.workspaceId)
        .eq('status', 'idle');

      const agents = (data ?? []) as Array<{ id: string; name: string; role?: string | null }>;
      if (agents.length === 0) return null;

      // Preference order: the Public-Communications agent ("The Voice") first,
      // then anyone else with a social/posting mandate. Content Writer is
      // intentionally last-resort — it authors copy but doesn't own the
      // posting surface, and it was previously winning the pick by matching
      // the "content" keyword, which produced tasks that never got posted.
      const tiers: Array<(a: { name: string; role?: string | null }) => boolean> = [
        (a) => /voice|public communic|public comm/i.test(`${a.name} ${a.role ?? ''}`),
        (a) => /social|twitter|\bx\b/i.test(`${a.name} ${a.role ?? ''}`),
        (a) => /\bpost|publish|broadcast/i.test(`${a.name} ${a.role ?? ''}`),
        (a) => /content/i.test(`${a.name} ${a.role ?? ''}`),
      ];
      for (const match of tiers) {
        const hit = agents.find(match);
        if (hit) return hit.id;
      }
      return agents[0]?.id ?? null;
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
    // Approved-draft bypass: if the operator has approved text sitting
    // in the workspace's x-approvals.jsonl, post it directly instead of
    // asking an agent to author one. Historically, agent authoring
    // produced a steady stream of capitulations ("## Tweet Ready for
    // Manual Posting") that silently counted as posts; pre-approved
    // text carries zero drift risk and already passed human review.
    if (this.options.approvalsJsonlPath) {
      try {
        const draft = selectApprovedDraft(this.options.approvalsJsonlPath);
        if (draft) {
          await this.dispatchFromApprovedDraft(agentId, draft);
          return;
        }
      } catch (err) {
        // Bypass is opportunistic — a broken queue must not break the
        // fallback path. Log and fall through to agent authoring.
        logger.warn(
          { err: err instanceof Error ? err.message : err },
          '[ContentCadenceScheduler] approved-draft bypass failed; falling back to agent authoring',
        );
      }
    }
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
   * Bypass path: post an operator-approved draft directly via the
   * deliverable executor, skipping the LLM-author iteration.
   *
   * Flow:
   *   1. Insert a task row that's ALREADY completed (trust_output=true,
   *      status=completed, deferred_action.params.text = draft text).
   *      We write the task row so every downstream metric surface
   *      (posts_today counter, goal current_value, content-cadence-
   *      loop-health) sees this as one completed tweet, just like
   *      an agent-authored one.
   *   2. Insert a companion deliverable row with status=approved and
   *      content.text = draft text. deliverable-executor reads it by
   *      task_id and does the real posting (dry-run unless
   *      runtime_settings.deliverable_executor_live='true').
   *   3. Invoke deliverableExecutor.executeForTask(taskId). Result
   *      ok=true → deliverable transitions approved→delivered, mark
   *      the draft consumed so we don't re-pick it. Result ok=false
   *      → route the task to status=failed with the handler error
   *      so the narrated-failure gate + sentinel still see a signal.
   *
   * Any throw in this path is caught by the outer dispatchXPostTask
   * wrapper; the scheduler logs and moves on. We don't fall back to
   * agent authoring on a bypass error because the draft may have
   * already been consumed — re-dispatching an agent task here could
   * double-post.
   */
  private async dispatchFromApprovedDraft(
    agentId: string,
    draft: ApprovedDraft,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const { data: taskData } = await this.db
      .from('agent_workforce_tasks')
      .insert({
        workspace_id: this.workspaceId,
        agent_id: agentId,
        title: 'Post one tweet today',
        input: `Post pre-approved draft ${draft.id} (no LLM authoring).`,
        output: `Posted via content-cadence bypass using approvals row ${draft.id}.`,
        status: 'completed',
        priority: 'normal',
        started_at: nowIso,
        completed_at: nowIso,
        metadata: JSON.stringify({
          trust_output: true,
          dispatcher: 'content_cadence',
          bypass: 'approved_draft',
          approved_draft_id: draft.id,
          approved_draft_ts: draft.ts,
          approved_draft_kind: draft.kind,
        }),
        deferred_action: JSON.stringify({
          type: 'post_tweet',
          provider: 'x',
          params: { text: draft.text },
        }),
      })
      .select('id')
      .single();
    if (!taskData) {
      logger.warn({ agentId, draftId: draft.id }, '[ContentCadenceScheduler] bypass task insert returned no id');
      return;
    }
    const taskId = (taskData as { id: string }).id;

    await this.db.from('agent_workforce_deliverables').insert({
      workspace_id: this.workspaceId,
      task_id: taskId,
      agent_id: agentId,
      deliverable_type: 'post',
      provider: 'x',
      title: `Dispatcher-authored post (approvals ${draft.id})`,
      content: JSON.stringify({
        text: draft.text,
        action_spec: { type: 'post_tweet', approved_draft_id: draft.id },
      }),
      status: 'approved',
      auto_created: 1,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // Holds the workspace CDP lane for the duration of the direct-post
    // path. The DM poller takes the same lane per inbox fetch and per
    // thread read, so the two schedulers serialize on the shared debug
    // Chrome rather than racing. Orchestrator-mediated posts via
    // engine.executeTask are NOT yet inside the lane — that requires
    // wrapping the x-posting tool dispatch and is tracked separately.
    const results = await withCdpLane(
      this.workspaceId,
      () => this.getExecutor().executeForTask(taskId),
      { label: 'content-cadence:bypass-post' },
    );
    const allOk = results.length > 0 && results.every((r) => r.ok);
    if (allOk) {
      if (this.options.approvalsJsonlPath) {
        markDraftConsumed(this.options.approvalsJsonlPath, draft.id, taskId);
      }
      logger.info(
        { agentId, taskId, draftId: draft.id, posted: results.length },
        '[ContentCadenceScheduler] posted via approved-draft bypass',
      );
    } else {
      const firstError = results.find((r) => !r.ok)?.error ?? 'no deliverable matched';
      await this.db
        .from('agent_workforce_tasks')
        .update({
          status: 'failed',
          failure_category: 'approved_draft_bypass',
          error_message: `Approved-draft bypass failed: ${firstError}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', taskId);
      logger.warn(
        { agentId, taskId, draftId: draft.id, err: firstError },
        '[ContentCadenceScheduler] approved-draft bypass failed; task routed to failed',
      );
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

