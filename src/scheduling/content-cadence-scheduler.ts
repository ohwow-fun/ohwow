/**
 * ContentCadenceScheduler — multi-platform content posting scheduler.
 *
 * Drives automated posting to X and Threads (opt-in per platform).
 * Each platform gets independent budget tracking, cooldown, goal rows,
 * and prompts. They share agent selection, the tick loop, and CDP lane
 * coordination.
 *
 * Every 15 minutes this scheduler, for each enabled platform:
 *   1. Ensures the platform's posts_per_week goal row exists.
 *   2. Reads the platform's posts_per_day from runtime_config_overrides.
 *   3. Counts delivered posts today for that platform.
 *   4. If under budget + cooldown clear, dispatches a post task.
 *   5. Updates the goal's current_value with the trailing-7d count.
 *
 * Workspace guard: only instantiated when workspaceSlug === 'default'.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { withCdpLane } from '../execution/browser/cdp-lane.js';
import type { RuntimeEngine } from '../execution/engine.js';
import { logger } from '../lib/logger.js';
import { loadPostedHashesForPlatform } from '../lib/posted-text-log.js';
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

// ---------------------------------------------------------------------------
// Platform slot definitions
// ---------------------------------------------------------------------------

export interface PlatformSlot {
  platform: 'x' | 'threads';
  goalId: string;
  goalMetric: string;
  goalTitle: string;
  goalDescription: string;
  goalColor: string;
  taskTitle: string;
  configKey: string;
  configDefault: number;
  promptConfigKey: string;
  defaultPrompt: string;
  deferredActionType: string;
  providerFilter: string;
  approvalsKinds: string[];
}

const DEFAULT_X_POST_PROMPT = `Post one tweet. One thing to ship.

Your reader is a stranger scrolling — builders, indie founders, and operators working in or around AI agents and automation. They don't follow you. They are scanning for something worth two seconds of attention. The tweet earns that by itself, with no thread setup and no "as I said yesterday."

A tweet earns its place when one of these is true:
(a) it names something specific that happened in the AI-agent space — a shipped thing, a model change, a failure mode you actually observed — concrete enough that a reader could quote it to a friend.
(b) it offers a sharp read on a pattern others haven't articulated — a widely-held assumption that's incomplete, a second-order consequence most people miss, a take you'd defend at a dinner party.
(c) it's a real question that surfaces an assumption the reader was making without noticing. Not rhetorical filler.

Voice. A builder who thinks clearly and doesn't hedge. Dry where it helps, warm where it helps, opinionated where it matters. You know the craft, so you can mention specific tools, models, or failure modes without explaining them.

Do not write the tweet as if it were a reply to something. Tweets stand alone. If the only shape you can find is a cryptic aside to an unnamed antecedent — "the real work is the part nobody sees", "naming the specific shade of X", "the booking link is right there" — you don't have enough context for the reader, and it will read like a misfired comment. Post something else.

If nothing genuinely worth posting comes to mind right now, end the task without posting. Thin content is worse than silence, and the account is not rewarded for hitting a quota of filler.

Form. Under 240 chars; 80-180 is the best range. No product pitches, CTAs, hashtags, links, emojis, or em dashes. Never name what you build or sell. No hype tropes ("the future of X", "AI will change everything") and no worn formats (nobody/me, setup-punchline, "X walks into Y", "that moment when"). Any number in the post needs a real reason behind it.

When you have something worth posting, post it directly. Do not ask for approval.`;

const DEFAULT_THREADS_POST_PROMPT = `Post one original Threads post. One thing to ship.

Your reader is a stranger scrolling Threads — builders, indie founders, and operators working in or around AI agents and automation. They don't follow you. They are scanning for something worth two seconds of attention. The post earns that by itself, with no thread setup and no "as I said yesterday."

A post earns its place when one of these is true:
(a) it names something specific that happened in the AI-agent space — a shipped thing, a model change, a failure mode you actually observed — concrete enough that a reader could quote it to a friend.
(b) it offers a sharp read on a pattern others haven't articulated — a widely-held assumption that's incomplete, a second-order consequence most people miss, a take you'd defend at a dinner party.
(c) it's a real question that surfaces an assumption the reader was making without noticing. Not rhetorical filler.

Voice. A builder who thinks clearly and doesn't hedge. Dry where it helps, warm where it helps, opinionated where it matters. You know the craft, so you can mention specific tools, models, or failure modes without explaining them.

Do not write the post as if it were a reply to something. Posts stand alone. If the only shape you can find is a cryptic aside to an unnamed antecedent — "the real work is the part nobody sees", "naming the specific shade of X", "the booking link is right there", "the matching algorithm is the only part that matters here" — you don't have enough context for the reader, and it will read like a misfired comment. Post something else.

If nothing genuinely worth posting comes to mind right now, end the task without posting. Thin content is worse than silence, and the account is not rewarded for hitting a quota of filler.

Form. Under 400 chars; 100-300 is the best range. Threads gives you more room than X, but shorter still wins. No product pitches, CTAs, hashtags, links, emojis, or em dashes. Never name what you build or sell. No hype tropes and no worn formats (nobody/me, setup-punchline, "that moment when"). Any number in the post needs a real reason behind it. Do not reuse text you posted on X — each platform gets its own.

When you have something worth posting, post it directly. Do not ask for approval.`;

export const X_SLOT: PlatformSlot = {
  platform: 'x',
  goalId: 'goal-x-posts-per-week',
  goalMetric: 'x_posts_per_week',
  goalTitle: 'X posts per week',
  goalDescription:
    'Post 7 times this week on X to maintain top-of-funnel cadence. ' +
    'Refreshed weekly — current_value is the trailing-7d post count.',
  goalColor: '#1DA1F2',
  taskTitle: 'Post one tweet today',
  configKey: CONTENT_CADENCE_CONFIG_KEY,
  configDefault: CONTENT_CADENCE_DEFAULT,
  promptConfigKey: 'content_cadence.post_prompt',
  defaultPrompt: DEFAULT_X_POST_PROMPT,
  deferredActionType: 'post_tweet',
  providerFilter: 'x',
  approvalsKinds: ['x_outbound_post'],
};

export const THREADS_SLOT: PlatformSlot = {
  platform: 'threads',
  goalId: 'goal-threads-posts-per-week',
  goalMetric: 'threads_posts_per_week',
  goalTitle: 'Threads posts per week',
  goalDescription:
    'Post 7 times this week on Threads to maintain top-of-funnel cadence. ' +
    'Refreshed weekly — current_value is the trailing-7d post count.',
  goalColor: '#000000',
  taskTitle: 'Post one Threads post today',
  configKey: 'content_cadence.threads_posts_per_day',
  configDefault: 1,
  promptConfigKey: 'content_cadence.threads_post_prompt',
  defaultPrompt: DEFAULT_THREADS_POST_PROMPT,
  deferredActionType: 'post_threads',
  providerFilter: 'threads',
  approvalsKinds: ['threads_outbound_post'],
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Trailing window for weekly count. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Default tick interval — every 15 minutes. */
/** Minimum gap between consecutive posts per platform (ms). */
const MIN_POST_GAP_MS = 30 * 60 * 1000;

/**
 * Agents blocked from the content-cadence posting pool even when idle
 * and name-matching. The default-workspace seed creates a "Social Media
 * Manager" agent with a generic SaaS-social-media system prompt
 * (hashtags, CTAs, "behind the scenes" language) that overrides our
 * cadence task voice brief at the system-prompt layer. When The Voice
 * is busy and SMM is the fallback, the LLM drifts to off-brand output
 * (salon / booking-link / beauty-shop content). The agent row stays
 * for non-posting flows; we just remove it from this scheduler's pool.
 */
const EXCLUDED_POSTER_NAMES = new Set(['Social Media Manager']);
const EXCLUDED_POSTER_ROLES = new Set(['Content Creator & Scheduler']);

// ---------------------------------------------------------------------------
// Options + class
// ---------------------------------------------------------------------------

export interface ContentCadenceSchedulerOptions {
  /** Path to the workspace's x-approvals.jsonl ledger. Both X and
   *  Threads drafts live in the same file, distinguished by `kind`. */
  approvalsJsonlPath?: string;
  /** Override the deliverable executor. Tests inject a fake. */
  deliverableExecutor?: DeliverableExecutor;
  /** Which platforms to schedule. Default: ['x']. */
  enabledPlatforms?: Array<'x' | 'threads'>;
}

export class ContentCadenceScheduler {
  private executing = false;
  private readonly options: ContentCadenceSchedulerOptions;
  private cachedExecutor: DeliverableExecutor | null = null;
  private readonly platformSlots: PlatformSlot[];

  constructor(
    private db: DatabaseAdapter,
    private engine: RuntimeEngine,
    private workspaceId: string,
    options: ContentCadenceSchedulerOptions = {},
  ) {
    this.options = options;
    const enabled = new Set(options.enabledPlatforms ?? ['x']);
    this.platformSlots = [];
    if (enabled.has('x')) this.platformSlots.push(X_SLOT);
    if (enabled.has('threads')) this.platformSlots.push(THREADS_SLOT);
  }

  private getExecutor(): DeliverableExecutor {
    if (this.options.deliverableExecutor) return this.options.deliverableExecutor;
    if (!this.cachedExecutor) this.cachedExecutor = new DeliverableExecutor(this.db);
    return this.cachedExecutor;
  }

  /** Single tick — runs each enabled platform slot sequentially.
   *  Reentrancy-guarded: if the automation scheduler overlaps (e.g.
   *  tick runs longer than the cron interval), the second call is a
   *  no-op rather than racing the first. */
  async tick(): Promise<void> {
    if (this.executing) return;
    this.executing = true;
    try {
      for (const slot of this.platformSlots) {
        await this.tickPlatform(slot);
      }
    } catch (err) {
      logger.error({ err }, '[ContentCadenceScheduler] tick failed');
    } finally {
      this.executing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Per-platform tick
  // -------------------------------------------------------------------------

  private async tickPlatform(slot: PlatformSlot): Promise<void> {
    try {
      await this.ensureGoalExists(slot);

      const postsPerDay = getRuntimeConfig<number>(slot.configKey, slot.configDefault);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const postsToday = await this.countPostsAfter(slot, todayStart.toISOString());

      logger.debug(
        { platform: slot.platform, postsPerDay, postsToday },
        '[ContentCadenceScheduler] daily budget check',
      );

      if (postsToday < postsPerDay) {
        const tooRecent = await this.lastPostTooRecent(slot);
        if (tooRecent) {
          logger.info(
            { platform: slot.platform },
            '[ContentCadenceScheduler] cooldown — last post too recent, skipping',
          );
        } else {
          const agentId = await this.findPostingAgent();
          if (agentId) {
            const pending = await this.countPendingApprovalsForAgent(agentId);
            if (pending >= 3) {
              logger.info(
                { agentId, pending, platform: slot.platform },
                '[ContentCadenceScheduler] pending approval backlog — skipping dispatch',
              );
            } else {
              await this.dispatchPostTask(slot, agentId);
            }
          } else {
            logger.warn(
              { workspaceId: this.workspaceId, platform: slot.platform },
              '[ContentCadenceScheduler] no idle agent found — skipping dispatch',
            );
          }
        }
      }

      const weekStart = new Date(Date.now() - WEEK_MS);
      const postsThisWeek = await this.countPostsAfter(slot, weekStart.toISOString());
      await this.updateWeeklyGoalValue(slot, postsThisWeek);
    } catch (err) {
      logger.error(
        { err, platform: slot.platform },
        '[ContentCadenceScheduler] tickPlatform failed',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Goal management
  // -------------------------------------------------------------------------

  private async ensureGoalExists(slot: PlatformSlot): Promise<void> {
    try {
      const { data } = await this.db
        .from<{ id: string; due_date: string | null }>('agent_workforce_goals')
        .select('id, due_date')
        .eq('id', slot.goalId);
      const rows = (data ?? []) as Array<{ id: string; due_date: string | null }>;

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
            .eq('id', slot.goalId);
          logger.info(
            { goalId: slot.goalId, nextDue: nextDue.toISOString().split('T')[0] },
            `[ContentCadenceScheduler] rolled ${slot.goalMetric} goal forward 7 days`,
          );
        }
        return;
      }

      const now = new Date().toISOString();
      const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      due.setHours(0, 0, 0, 0);

      await this.db.from('agent_workforce_goals').insert({
        id: slot.goalId,
        workspace_id: this.workspaceId,
        title: slot.goalTitle,
        description: slot.goalDescription,
        target_metric: slot.goalMetric,
        target_value: 7.0,
        current_value: 0.0,
        unit: 'posts/week',
        status: 'active',
        priority: 'high',
        due_date: due.toISOString().split('T')[0],
        color: slot.goalColor,
        icon: null,
        position: 0,
        created_at: now,
        updated_at: now,
      });

      logger.info(
        { goalId: slot.goalId, workspaceId: this.workspaceId },
        `[ContentCadenceScheduler] seeded ${slot.goalMetric} goal`,
      );
    } catch (err) {
      logger.debug({ err }, `[ContentCadenceScheduler] ensureGoalExists error for ${slot.platform} (likely race, ignored)`);
    }
  }

  // -------------------------------------------------------------------------
  // Counting + cooldown
  // -------------------------------------------------------------------------

  private async countPostsAfter(slot: PlatformSlot, since: string): Promise<number> {
    try {
      const { data } = await this.db
        .from<{ id: string; delivered_at: string | null }>('agent_workforce_deliverables')
        .select('id, delivered_at')
        .eq('workspace_id', this.workspaceId)
        .eq('status', 'delivered')
        .eq('provider', slot.providerFilter);

      const rows = (data ?? []) as Array<{ delivered_at: string | null }>;
      return rows.filter((r) => !!r.delivered_at && r.delivered_at >= since).length;
    } catch (err) {
      logger.warn({ err, since, platform: slot.platform }, '[ContentCadenceScheduler] countPostsAfter failed');
      return 0;
    }
  }

  private async lastPostTooRecent(slot: PlatformSlot): Promise<boolean> {
    try {
      const { data } = await this.db
        .from<{ created_at: string }>('agent_workforce_tasks')
        .select('created_at')
        .eq('workspace_id', this.workspaceId)
        .eq('title', slot.taskTitle)
        .order('created_at', { ascending: false })
        .limit(1);
      const rows = (data ?? []) as Array<{ created_at: string | null }>;
      if (rows.length === 0 || !rows[0].created_at) return false;
      const ts = rows[0].created_at;
      const iso = /Z$|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z';
      const elapsed = Date.now() - new Date(iso).getTime();
      return elapsed < MIN_POST_GAP_MS;
    } catch {
      return false;
    }
  }

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

  // -------------------------------------------------------------------------
  // Agent selection
  // -------------------------------------------------------------------------

  private async findPostingAgent(): Promise<string | null> {
    try {
      const { data } = await this.db
        .from<{ id: string; name: string; role: string | null }>('agent_workforce_agents')
        .select('id, name, role')
        .eq('workspace_id', this.workspaceId)
        .eq('status', 'idle');

      const raw = (data ?? []) as Array<{ id: string; name: string; role?: string | null }>;
      // Exclude the generic "Social Media Manager" seed agent from the
      // posting pool. Its persona is a SaaS social-media template
      // (hashtags, CTAs, "behind the scenes", casual tone) which
      // overrides our cadence task voice brief at the system-prompt
      // layer and produces off-brand posts (beauty-shop / salon /
      // booking-link content) whenever The Voice is busy and SMM is
      // the fallback. Keep the row for non-posting flows; block it
      // here so content-cadence only lands on voice-aligned agents.
      const agents = raw.filter(
        (a) =>
          !EXCLUDED_POSTER_NAMES.has(a.name) &&
          !(a.role ? EXCLUDED_POSTER_ROLES.has(a.role) : false),
      );
      if (agents.length === 0) return null;

      const tiers: Array<(a: { name: string; role?: string | null }) => boolean> = [
        (a) => /voice|public communic|public comm/i.test(`${a.name} ${a.role ?? ''}`),
        (a) => /social|twitter|\bx\b|threads/i.test(`${a.name} ${a.role ?? ''}`),
        (a) => /\bpost|publish|broadcast/i.test(`${a.name} ${a.role ?? ''}`),
        (a) => /content/i.test(`${a.name} ${a.role ?? ''}`),
      ];
      for (const match of tiers) {
        const hit = agents.find(match);
        if (hit) return hit.id;
      }
      return agents[0]?.id ?? null;
    } catch (err) {
      logger.warn({ err }, '[ContentCadenceScheduler] findPostingAgent failed');
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Voice gate chain for new channel additions:
   *   1. buildDraftMessage() or LLM-authored fallback produces the text.
   *   2. voiceCheck(text, { platform, useCase: 'post' }) enforces brand rules.
   *   3. Only gate-passing drafts reach proposeApproval() or task dispatch.
   * Skipping any step risks off-brand copy reaching the operator queue.
   */
  private async dispatchPostTask(slot: PlatformSlot, agentId: string): Promise<void> {
    // Approved-draft bypass
    if (this.options.approvalsJsonlPath) {
      try {
        const denied = await this.loadDeniedTextHashes(slot);
        const draft = selectApprovedDraft(this.options.approvalsJsonlPath, {
          kinds: slot.approvalsKinds,
          deniedTextHashes: denied,
        });
        if (draft) {
          await this.dispatchFromApprovedDraft(slot, agentId, draft);
          return;
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, platform: slot.platform },
          '[ContentCadenceScheduler] approved-draft bypass failed; falling back to agent authoring',
        );
      }
    }

    // Agent-authoring fallback
    try {
      const prompt = getRuntimeConfig<string>(slot.promptConfigKey, slot.defaultPrompt);

      const { data: taskData } = await this.db
        .from('agent_workforce_tasks')
        .insert({
          workspace_id: this.workspaceId,
          agent_id: agentId,
          title: slot.taskTitle,
          input: prompt,
          status: 'pending',
          priority: 'normal',
          metadata: JSON.stringify({ trust_output: true, dispatcher: 'content_cadence', platform: slot.platform }),
          deferred_action: JSON.stringify({ type: slot.deferredActionType, provider: slot.providerFilter, params: {} }),
        })
        .select('id')
        .single();

      if (!taskData) {
        logger.warn({ agentId, platform: slot.platform }, '[ContentCadenceScheduler] task insert returned no id');
        return;
      }

      const taskId = (taskData as { id: string }).id;

      this.engine.executeTask(agentId, taskId).catch((err: unknown) => {
        logger.error({ err, agentId, taskId, platform: slot.platform }, '[ContentCadenceScheduler] task execution failed');
      });

      logger.info(
        { agentId, taskId, platform: slot.platform },
        `[ContentCadenceScheduler] dispatched ${slot.platform} post task`,
      );
    } catch (err) {
      logger.error({ err, agentId, platform: slot.platform }, '[ContentCadenceScheduler] dispatchPostTask failed');
    }
  }

  // -------------------------------------------------------------------------
  // Dedup hash loading
  // -------------------------------------------------------------------------

  private async loadDeniedTextHashes(slot: PlatformSlot): Promise<Set<string>> {
    // Read from posted_log (platform-generic table)
    const denied = await loadPostedHashesForPlatform(
      this.db,
      this.workspaceId,
      slot.platform,
    );

    // For X, also read from legacy x_posted_log for backward compat
    if (slot.platform === 'x') {
      try {
        const cutoffIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const { data } = await this.db
          .from<{ text_hash: string }>('x_posted_log')
          .select('text_hash')
          .eq('workspace_id', this.workspaceId)
          .gte('posted_at', cutoffIso);
        for (const row of (data ?? []) as Array<{ text_hash: string }>) {
          if (typeof row.text_hash === 'string' && row.text_hash.length > 0) {
            denied.add(row.text_hash);
          }
        }
      } catch (err) {
        logger.debug(
          { err: err instanceof Error ? err.message : err },
          '[ContentCadenceScheduler] loadDeniedTextHashes (x_posted_log) failed; continuing',
        );
      }
    }

    return denied;
  }

  // -------------------------------------------------------------------------
  // Approved-draft bypass
  // -------------------------------------------------------------------------

  private async dispatchFromApprovedDraft(
    slot: PlatformSlot,
    agentId: string,
    draft: ApprovedDraft,
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const { data: taskData } = await this.db
      .from('agent_workforce_tasks')
      .insert({
        workspace_id: this.workspaceId,
        agent_id: agentId,
        title: slot.taskTitle,
        input: `Post pre-approved draft ${draft.id} (no LLM authoring).`,
        output: `Posted via content-cadence bypass using approvals row ${draft.id}.`,
        status: 'completed',
        priority: 'normal',
        started_at: nowIso,
        completed_at: nowIso,
        metadata: JSON.stringify({
          trust_output: true,
          dispatcher: 'content_cadence',
          platform: slot.platform,
          bypass: 'approved_draft',
          approved_draft_id: draft.id,
          approved_draft_ts: draft.ts,
          approved_draft_kind: draft.kind,
        }),
        deferred_action: JSON.stringify({
          type: slot.deferredActionType,
          provider: slot.providerFilter,
          params: { text: draft.text },
        }),
      })
      .select('id')
      .single();
    if (!taskData) {
      logger.warn({ agentId, draftId: draft.id, platform: slot.platform }, '[ContentCadenceScheduler] bypass task insert returned no id');
      return;
    }
    const taskId = (taskData as { id: string }).id;

    await this.db.from('agent_workforce_deliverables').insert({
      workspace_id: this.workspaceId,
      task_id: taskId,
      agent_id: agentId,
      deliverable_type: 'post',
      provider: slot.providerFilter,
      title: `Dispatcher-authored post (approvals ${draft.id})`,
      content: JSON.stringify({
        text: draft.text,
        action_spec: { type: slot.deferredActionType, approved_draft_id: draft.id },
      }),
      status: 'approved',
      auto_created: 1,
      created_at: nowIso,
      updated_at: nowIso,
    });

    const results = await withCdpLane(
      this.workspaceId,
      () => this.getExecutor().executeForTask(taskId),
      { label: `content-cadence:bypass-post:${slot.platform}` },
    );
    const allOk = results.length > 0 && results.every((r) => r.ok);
    if (allOk) {
      if (this.options.approvalsJsonlPath) {
        markDraftConsumed(this.options.approvalsJsonlPath, draft.id, taskId);
      }
      logger.info(
        { agentId, taskId, draftId: draft.id, platform: slot.platform, posted: results.length },
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
        { agentId, taskId, draftId: draft.id, platform: slot.platform, err: firstError },
        '[ContentCadenceScheduler] approved-draft bypass failed; task routed to failed',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Goal updates
  // -------------------------------------------------------------------------

  private async updateWeeklyGoalValue(slot: PlatformSlot, count: number): Promise<void> {
    try {
      await this.db
        .from('agent_workforce_goals')
        .update({
          current_value: count,
          updated_at: new Date().toISOString(),
        })
        .eq('id', slot.goalId);
    } catch (err) {
      logger.warn({ err, count, platform: slot.platform }, '[ContentCadenceScheduler] updateWeeklyGoalValue failed');
    }
  }
}
