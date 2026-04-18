/**
 * X posting tool executor — task-agent dispatch for x_compose_tweet,
 * x_compose_thread, x_compose_article, x_list_dms, x_send_dm,
 * x_delete_tweet.
 *
 * Why this exists
 * ---------------
 * The X posting tools were registered in the CHAT orchestrator's
 * dispatch map (src/orchestrator/tool-executor.ts:540-690) but not in
 * the TASK agent's dispatch registry (src/execution/tool-dispatch/).
 * After Patch A exposed the tools to the task-agent LLM catalog
 * (tool-list.ts), the Voice agent correctly picked `x_compose_tweet`
 * on iteration 2 — but the task-agent dispatch returned
 * `Error: Unknown tool: x_compose_tweet` (ToolExecutorRegistry's no-
 * handler-found fallback), so the agent fell through to
 * `request_browser` + raw `browser_navigate`, bypassing all profile
 * pinning.
 *
 * This executor closes the split. It replicates the profile-pinned
 * path from the chat orchestrator exactly:
 *
 *   1. Pick the target Chrome profile (explicit input.profile →
 *      runtime_settings.x_posting_profile → handle-derived from
 *      runtime_settings.x_posting_handle → first-with-email →
 *      first profile overall). Mirrors `deliverable-executor.
 *      ensureProfileChrome` preference order.
 *   2. `ensureDebugChrome({preferredProfile})` + `openProfileWindow`
 *      with `url: 'https://x.com/home'` to get a fresh tab in the
 *      right `browserContextId`. Both emit ledger events
 *      (chrome-profile-events.jsonl) so BrowserProfileGuardian
 *      observes every X-posting invocation.
 *   3. Read `expectedHandle` from runtime_settings.x_posting_handle
 *      so `composeTweetViaBrowser` verifies the sidebar's active
 *      account BEFORE typing.
 *   4. Dispatch to the matching `composeXViaBrowser` function with
 *      `expectedBrowserContextId` pinned.
 *
 * Defaults to dry_run=true per the chat orchestrator's convention —
 * an accidental LLM call never publishes. The agent must pass
 * `dry_run: false` explicitly to go live.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import {
  composeTweetViaBrowser,
  composeThreadViaBrowser,
  composeArticleViaBrowser,
  sendDmViaBrowser,
  listDmsViaBrowser,
  deleteLastTweetViaBrowser,
} from '../../orchestrator/tools/x-posting.js';
import {
  scanXPostsViaBrowser,
  composeTweetReplyViaBrowser,
} from '../../orchestrator/tools/x-reply.js';
import { deleteXReplyViaBrowser } from '../../orchestrator/tools/x-delete.js';
import {
  ensureDebugChrome,
  findProfileByIdentity,
  listProfiles,
  openProfileWindow,
  findExistingTabForHost,
  findReusableTabForHost,
  closeTabById,
} from '../browser/chrome-profile-router.js';
import { claimTarget, releaseAllForOwner } from '../browser/browser-claims.js';
import { withProfileLock } from '../browser/profile-mutex.js';
import { withTabRecovery } from '../browser/tab-recovery.js';
import { profileByHandleHint } from '../browser/chrome-lifecycle.js';
import { logger } from '../../lib/logger.js';
import { withTimeout, TimeoutError } from '../../lib/with-timeout.js';

const X_POSTING_TOOL_NAMES = new Set([
  'x_compose_tweet',
  'x_compose_thread',
  'x_compose_article',
  'x_send_dm',
  'x_list_dms',
  'x_delete_tweet',
  'x_scan_posts',
  'x_compose_reply',
  'x_delete_reply',
]);

// Per-tool deadline. X DOM ops that take longer than this are either
// Chrome-is-dead or a stuck selector loop. Without this bound a single
// hung call wedges the task-agent iteration forever (task
// 8ab9c20fe715bda8dd4e3d6aa49808e8, 2026-04-16).
const TOOL_TIMEOUT_MS: Record<string, number> = {
  x_compose_tweet: 90_000,
  x_compose_thread: 180_000,
  x_compose_article: 240_000,
  x_send_dm: 60_000,
  x_list_dms: 30_000,
  x_delete_tweet: 60_000,
  x_scan_posts: 45_000,
  x_compose_reply: 90_000,
  x_delete_reply: 60_000,
};
const DEFAULT_TOOL_TIMEOUT_MS = 90_000;

async function readLiveMode(ctx: ToolExecutionContext): Promise<boolean> {
  const raw = await readSetting(ctx, 'deliverable_executor_live');
  return raw === 'true' || raw === '1';
}

async function readSetting(ctx: ToolExecutionContext, key: string): Promise<string | null> {
  try {
    const { data } = await ctx.db
      .from('runtime_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    const val = (data as { value: string } | null)?.value;
    return val && val.trim().length > 0 ? val.trim() : null;
  } catch {
    return null;
  }
}

export const xPostingExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return X_POSTING_TOOL_NAMES.has(toolName);
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    // ---- 1. Resolve target Chrome profile ----
    let profiles: ReturnType<typeof listProfiles>;
    try {
      profiles = listProfiles();
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }
    if (profiles.length === 0) {
      return {
        content: 'Error: No Chrome profiles found in ~/.ohwow/chrome-cdp/. Log into X in desktop Chrome via onboarding, or set runtime_settings.x_posting_profile.',
        is_error: true,
      };
    }

    const profileOverride = typeof input.profile === 'string' && input.profile.trim().length > 0
      ? input.profile.trim()
      : null;
    const profileHint = profileOverride || (await readSetting(ctx, 'x_posting_profile'));
    // Handle-derived fallback only when no explicit profile hint is set.
    const handleHint = profileHint ? null : await readSetting(ctx, 'x_posting_handle');

    const target = (profileHint && findProfileByIdentity(profiles, profileHint))
      || (handleHint && profileByHandleHint(profiles, handleHint))
      || profiles.find((p) => !!p.email)
      || profiles[0];

    // ---- 2. Ensure Chrome + reuse-or-open profile tab → browserContextId ----
    // Reuse an existing x.com tab when one is already open (from a prior
    // cadence fire). Compose/scan/reply prefer reusing an UNCLAIMED agent
    // tab (kills the "new window every fire" regression under the
    // task-scoped claims model); DM tools can additionally fall back to
    // ANY matching tab the operator already has open so they land in the
    // right conversation. The whole lookup-and-open-or-claim sequence
    // runs under `withProfileLock(target.directory)` so two concurrent
    // tasks on the same profile can't both see "no match" and each
    // open their own window — the second waits for the first to claim
    // its tab, then reuses it.
    const dmToolNames = new Set(['x_send_dm', 'x_list_dms', 'x_delete_reply', 'x_delete_tweet']);
    const ownershipMode = dmToolNames.has(toolName) ? 'any' : 'ours';
    // Owner string for claim scoping. `ctx.taskId` scopes each claim to
    // the task that created the tab so two concurrent tasks can't
    // clobber each other's CDP attaches. Parallel runs of the SAME task
    // id (shouldn't happen, but defensively) re-use the same owner and
    // get idempotent claim semantics.
    const claimOwner = ctx.taskId;
    // `freshTargetId` is updated by the most recent acquire() attempt so
    // the post-run cleanup can close a broken tab we just opened. On
    // recovery, the previous attempts' target ids are already gone
    // (destroyed by whatever closed the tab), so tracking only the
    // latest is correct.
    let freshTargetId: string | null = null;

    async function acquireXTab(): Promise<{
      page: { expectedBrowserContextId: string | undefined };
      targetId: string;
      release: () => void;
    }> {
      // Release any claim the previous attempt might have left behind
      // so findReusable doesn't try to double-claim under the same
      // owner. Safe to call when no claim exists (returns 0).
      releaseAllForOwner(claimOwner);
      freshTargetId = null;
      let localContextId: string | undefined;
      let localFreshTargetId: string | null = null;
      await withProfileLock(target.directory, async () => {
        await ensureDebugChrome({ preferredProfile: target.directory });
        // First pass: reuse an unclaimed x.com tab under this profile.
        // `findReusableTabForHost` atomically claims the tab and
        // navigates it back to the host landing page (resetTab) so a
        // prior task's dirty state — modal, scroll, half-typed draft —
        // doesn't leak into this one.
        const reusable = await findReusableTabForHost({
          hostMatch: 'x.com',
          profileDir: target.directory,
          owner: claimOwner,
          resetUrl: 'https://x.com/home',
        });
        if (reusable) {
          localContextId = reusable.browserContextId ?? undefined;
          // Browser WS is per-lookup; drop it now so the composer's
          // own ensureCdpBrowser gets a clean one.
          reusable.page.close();
          reusable.closeBrowser();
          return;
        }

        // DM tools (ownershipMode='any') also accept operator-owned
        // tabs as a fallback — the operator may have a DM conversation
        // open in their own x.com tab and we should pick that up.
        if (ownershipMode === 'any') {
          const operatorTab = await findExistingTabForHost('x.com', { ownershipMode: 'any' });
          if (operatorTab) {
            localContextId = operatorTab.browserContextId ?? undefined;
            return;
          }
        }

        // Second pass: no reusable tab exists, so open a fresh window
        // and claim it under this task.
        const opened = await openProfileWindow({
          profileDir: target.directory,
          url: 'https://x.com/home',
        });
        localContextId = opened.browserContextId ?? undefined;
        localFreshTargetId = opened.targetId;
        const claim = claimTarget(
          { profileDir: target.directory, targetId: opened.targetId },
          claimOwner,
        );
        if (!claim) {
          logger.warn(
            { targetId: opened.targetId.slice(0, 8), profileDir: target.directory, owner: claimOwner },
            '[x-posting-executor] freshly opened tab already claimed by another owner — racing task likely; closing and bailing',
          );
          await closeTabById(opened.targetId);
          throw new Error('Couldn\'t claim x.com tab (racing task holds it). Retry.');
        }
      });
      freshTargetId = localFreshTargetId;
      return {
        page: { expectedBrowserContextId: localContextId },
        targetId: localFreshTargetId ?? 'reused',
        release: () => {
          // Release task-scoped claims so a recovery attempt (or the
          // final success path, which is idempotent) can re-claim a
          // fresh tab. Safe to call when no claim was created.
          releaseAllForOwner(claimOwner);
        },
      };
    }

    // ---- 3. Read expected handle for identity verification ----
    const expectedHandleRaw = await readSetting(ctx, 'x_posting_handle');
    const expectedHandle = expectedHandleRaw ? expectedHandleRaw.replace(/^@/, '') : undefined;

    // ---- 4. Dispatch to the matching composer ----
    // Dry-run default flips with runtime_settings.deliverable_executor_live.
    // When the operator has enabled live delivery, agent tool-calls that
    // omit dry_run publish for real (this is the cadence post path — the
    // agent inherits intent from the task's deferred_action and would
    // never publish otherwise). When the live flag is off, default stays
    // dry_run=true so chat-driven tool-calls remain safe by accident.
    // Explicit input.dry_run=true/false always wins over the default.
    const liveFlag = await readLiveMode(ctx);
    const dryRun = typeof input.dry_run === 'boolean' ? input.dry_run : !liveFlag;
    let result: {
      success: boolean;
      message: string;
      screenshotBase64?: string;
      tweetsTyped?: number;
      tweetsPublished?: number;
      currentUrl?: string;
      landedAt?: string;
      threads?: unknown[];
      replyTyped?: number;
      replyPublished?: number;
    } | undefined;
    const timeoutMs = TOOL_TIMEOUT_MS[toolName] ?? DEFAULT_TOOL_TIMEOUT_MS;
    try {
      // Acquisition runs inside `withTabRecovery` so a tab the user
      // closes mid-call causes a re-acquire + retry instead of an
      // end-to-end failure. The first acquire happens synchronously
      // inside withTabRecovery so any Chrome-bring-up error still
      // surfaces as an executor error (same as the old behavior).
      // Logging stage boundaries ('acquired', 'fn-start', 'fn-done')
      // makes the retry trail visible in the daemon logs.
      logger.debug({ tool: toolName, taskId: ctx.taskId }, '[x-posting-executor] acquiring x.com tab');
      result = await withTabRecovery(
        { acquire: acquireXTab, label: 'x-posting', maxRetries: 2 },
        async ({ expectedBrowserContextId }) => {
          logger.debug(
            { tool: toolName, taskId: ctx.taskId, ctx: expectedBrowserContextId?.slice(0, 8) },
            '[x-posting-executor] tab acquired; dispatching composer',
          );
          return withTimeout(`x-posting:${toolName}`, timeoutMs, async () => {
            if (toolName === 'x_compose_tweet') {
              return composeTweetViaBrowser({
                text: String(input.text || ''),
                dryRun,
                expectedHandle,
                expectedBrowserContextId,
              });
            }
            if (toolName === 'x_compose_thread') {
              const tweets = Array.isArray(input.tweets) ? (input.tweets as string[]) : [];
              return composeThreadViaBrowser({ tweets, dryRun, expectedBrowserContextId });
            }
            if (toolName === 'x_compose_article') {
              return composeArticleViaBrowser({
                title: String(input.title || ''),
                body: String(input.body || ''),
                dryRun,
                expectedBrowserContextId,
              });
            }
            if (toolName === 'x_send_dm') {
              return sendDmViaBrowser({
                conversationPair: input.conversation_pair as string | undefined,
                handle: input.handle as string | undefined,
                text: String(input.text || ''),
                dryRun,
                expectedBrowserContextId,
              });
            }
            if (toolName === 'x_list_dms') {
              const listed = await listDmsViaBrowser({
                limit: input.limit as number | undefined,
                expectedBrowserContextId,
              });
              return {
                success: listed.success,
                message: listed.message,
                screenshotBase64: listed.screenshotBase64,
                threads: listed.threads as unknown[],
              };
            }
            if (toolName === 'x_scan_posts') {
              const scanned = await scanXPostsViaBrowser({
                source: String(input.source || ''),
                limit: typeof input.limit === 'number' ? input.limit : undefined,
                scrollRounds: typeof input.scroll_rounds === 'number' ? input.scroll_rounds : undefined,
                expectedBrowserContextId,
              });
              return {
                success: scanned.success,
                message: scanned.message,
                screenshotBase64: scanned.screenshotBase64,
                currentUrl: scanned.currentUrl,
                threads: scanned.tweets as unknown[],
              };
            }
            if (toolName === 'x_compose_reply') {
              return composeTweetReplyViaBrowser({
                replyToUrl: String(input.reply_to_url || ''),
                text: String(input.text || ''),
                dryRun,
                expectedHandle,
                expectedBrowserContextId,
                db: ctx.db,
                workspaceId: ctx.workspaceId,
              });
            }
            if (toolName === 'x_delete_reply') {
              const del = await deleteXReplyViaBrowser({
                postUrl: String(input.post_url || ''),
                authorHandle: String(input.author_handle || ''),
                containsText: typeof input.contains_text === 'string' ? input.contains_text : undefined,
                dryRun,
                expectedBrowserContextId,
              });
              return {
                success: del.success,
                message: del.message,
                screenshotBase64: del.screenshotBase64,
                currentUrl: del.currentUrl,
              };
            }
            // x_delete_tweet
            return deleteLastTweetViaBrowser({
              handle: String(input.handle || ''),
              marker: String(input.marker || ''),
              dryRun,
              expectedBrowserContextId,
            });
          });
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof TimeoutError) {
        logger.error(
          { tool: toolName, timeoutMs, elapsedMs: err.elapsedMs },
          '[x-posting-executor] composer exceeded timeout — likely Chrome crash, login redirect loop, or selector hang',
        );
        return {
          content: `Error: ${toolName} timed out after ${timeoutMs}ms (likely Chrome crash, login redirect loop, or selector hang). Task should retry or human should check Chrome state.`,
          is_error: true,
        };
      }
      logger.error(
        { err: msg, tool: toolName },
        '[x-posting-executor] composer handler crashed',
      );
      return { content: `Error: x-posting handler crashed: ${msg}`, is_error: true };
    } finally {
      // Keep owned tabs alive for reuse across ticks. The ownership
      // registry + 'ours' lookup guarantees we won't accumulate more
      // than one owned x.com tab per daemon lifetime — the next tick
      // finds this one via findExistingTabForHost and attaches
      // directly, avoiding the open/close flash and re-hydration that
      // cost ~1s per cycle. On compose error (result unassigned, or
      // success=false), close the tab: keeping a broken tab in the
      // registry would permanently block future ticks.
      if (freshTargetId) {
        const composeFailed = !result || result.success === false;
        if (composeFailed) {
          await closeTabById(freshTargetId);
        }
      }
      // Release task-scoped claims so the next task run (a retry, or
      // the next cadence fire) can re-claim the same tab. Safe to call
      // even when no claim was created (returns 0).
      releaseAllForOwner(claimOwner);
    }

    // ---- 5. Shape the result for the agent ----
    const envelope: Record<string, unknown> = {
      success: result.success,
      message: result.message,
    };
    if (result.currentUrl) envelope.currentUrl = result.currentUrl;
    if (result.tweetsTyped !== undefined) envelope.tweetsTyped = result.tweetsTyped;
    if (result.tweetsPublished !== undefined) envelope.tweetsPublished = result.tweetsPublished;
    if (result.replyTyped !== undefined) envelope.replyTyped = result.replyTyped;
    if (result.replyPublished !== undefined) envelope.replyPublished = result.replyPublished;
    if (result.landedAt !== undefined) envelope.landedAt = result.landedAt;
    if (result.threads !== undefined) envelope.threads = result.threads;
    envelope.dry_run = dryRun;
    envelope.profile_used = target.email || target.directory;

    return {
      content: JSON.stringify(envelope),
      is_error: !result.success,
    };
  },
};
