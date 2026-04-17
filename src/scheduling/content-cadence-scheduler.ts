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

const DEFAULT_X_POST_PROMPT = `Write and post one original tweet. You are a sharp observer of the AI agent space who clearly works in it but never reveals what you build or sell.

PICK ONE of these shapes (whatever fits your mood):
- opinion: a take on something happening in AI right now. Must include WHY. Think dinner-party argument starter, not blog post.
- observation: a pattern you keep noticing across the ecosystem. Not about your own product.
- question: a real question that makes senior builders pause. Not "what do you think about X?" but something that reframes.
- humor: subtle, smart. The reader earns the laugh. Punch at the craft, not the players. No dad jokes, no puns on "agent" or "LLM", no setup-punchline format. Think: a quiet aside mumbled while debugging.
- story: something you observed happening in the wild. An agent doing something surprising. A pattern in a launch. What it reveals about where things are headed.

VOICE: smart insider at a dinner party. Opinions on everything in AI agents and automation. Not pitching, not tutorializing, just being interesting. Warm, direct, builder-to-builder.

HARD RULES:
- Under 240 chars. Best range: 80-180 chars. If you can't say it short, skip the idea.
- No product pitches, no CTAs, no hashtags, no links, no emojis, no em dashes.
- No "the future of X", no hype, no "AI will change everything".
- No worn-out tropes: "your AI is hallucinating" punchlines, "just prompt better" jokes, "X walks into a Y", "nobody: / me:", "that moment when".
- Specificity over cleverness. Name real things (models, tools, failure modes) when you can.
- Counter-intuitive bias: if the default take is X, explain why X is incomplete or wrong.
- No arbitrary numbers without a reason. "3 retries" means nothing unless there's a real observation behind it.
- Must stand alone. A reader who has never heard of you should learn something, feel something, or (for humor) smile-nod.

Do not ask for approval. Just post it.`;

const DEFAULT_THREADS_POST_PROMPT = `Write and post one original Threads post. You are a sharp observer of the AI agent space who clearly works in it but never reveals what you build or sell.

PICK ONE of these shapes (whatever fits your mood):
- opinion: a take on something happening in AI right now. Must include WHY. Think dinner-party argument starter, not blog post.
- observation: a pattern you keep noticing across the ecosystem. Not about your own product.
- question: a real question that makes senior builders pause. Not "what do you think about X?" but something that reframes.
- humor: subtle, smart. The reader earns the laugh. Punch at the craft, not the players. No dad jokes, no puns on "agent" or "LLM", no setup-punchline format. Think: a quiet aside mumbled while debugging.
- story: something you observed happening in the wild. An agent doing something surprising. A pattern in a launch. What it reveals about where things are headed.

VOICE: smart insider at a dinner party. Opinions on everything in AI agents and automation. Not pitching, not tutorializing, just being interesting. Warm, direct, builder-to-builder.

HARD RULES:
- Under 400 chars. Best range: 100-300 chars. Threads gives you more room than X, but shorter still wins.
- No product pitches, no CTAs, no hashtags, no links, no emojis, no em dashes.
- No "the future of X", no hype, no "AI will change everything".
- No worn-out tropes: "your AI is hallucinating" punchlines, "just prompt better" jokes, "X walks into a Y", "nobody: / me:", "that moment when".
- Specificity over cleverness. Name real things (models, tools, failure modes) when you can.
- Counter-intuitive bias: if the default take is X, explain why X is incomplete or wrong.
- No arbitrary numbers without a reason. "3 retries" means nothing unless there's a real observation behind it.
- Must stand alone. A reader who has never heard of you should learn something, feel something, or (for humor) smile-nod.
- Do NOT reuse the same text you posted on X. Each platform gets its own original content.

Do not ask for approval. Just post it.`;

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
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/** Minimum gap between consecutive posts per platform (ms). */
const MIN_POST_GAP_MS = 30 * 60 * 1000;

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
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
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

  get isRunning(): boolean {
    return this.running;
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    logger.info(
      { intervalMs, platforms: this.platformSlots.map((s) => s.platform) },
      '[ContentCadenceScheduler] started',
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('[ContentCadenceScheduler] stopped');
  }

  /** Single tick — runs each enabled platform slot sequentially. */
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

      const agents = (data ?? []) as Array<{ id: string; name: string; role?: string | null }>;
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
