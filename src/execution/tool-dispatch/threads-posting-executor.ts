/**
 * Threads posting tool executor — task-agent dispatch for
 * threads_compose_post, threads_compose_thread, threads_read_profile.
 *
 * Mirrors x-posting-executor.ts: resolves the target Chrome profile,
 * ensures debug Chrome is up, opens the profile window, reads the
 * expected handle, and dispatches to the matching composer function.
 *
 * Defaults to dry_run=true per safety convention.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import {
  composeThreadsPostViaBrowser,
  composeThreadsThreadViaBrowser,
  readThreadsProfileViaBrowser,
} from '../../orchestrator/tools/threads-posting.js';
import {
  scanThreadsPostsViaBrowser,
  composeThreadsReplyViaBrowser,
} from '../../orchestrator/tools/threads-reply.js';
import { deleteThreadsReplyViaBrowser } from '../../orchestrator/tools/threads-delete.js';
import {
  ensureDebugChrome,
  findProfileByIdentity,
  listProfiles,
  openProfileWindow,
  findExistingTabForHost,
  closeTabById,
} from '../browser/chrome-profile-router.js';
import { claimTarget, releaseAllForOwner } from '../browser/browser-claims.js';
import { profileByHandleHint } from '../browser/chrome-lifecycle.js';
import { logger } from '../../lib/logger.js';
import { withTimeout, TimeoutError } from '../../lib/with-timeout.js';

const THREADS_TOOL_NAMES = new Set([
  'threads_compose_post',
  'threads_compose_thread',
  'threads_read_profile',
  'threads_scan_posts',
  'threads_compose_reply',
  'threads_delete_reply',
]);

const TOOL_TIMEOUT_MS: Record<string, number> = {
  threads_compose_post: 90_000,
  threads_compose_thread: 180_000,
  threads_read_profile: 30_000,
  threads_scan_posts: 45_000,
  threads_compose_reply: 90_000,
  threads_delete_reply: 60_000,
};
const DEFAULT_TOOL_TIMEOUT_MS = 90_000;

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

async function readLiveMode(ctx: ToolExecutionContext): Promise<boolean> {
  const raw = await readSetting(ctx, 'deliverable_executor_live');
  return raw === 'true' || raw === '1';
}

export const threadsPostingExecutor: ToolExecutor = {
  canHandle(toolName: string): boolean {
    return THREADS_TOOL_NAMES.has(toolName);
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
        content: 'Error: No Chrome profiles found in ~/.ohwow/chrome-cdp/. Log into Threads in desktop Chrome via onboarding.',
        is_error: true,
      };
    }

    const profileOverride = typeof input.profile === 'string' && input.profile.trim().length > 0
      ? input.profile.trim()
      : null;
    const profileHint = profileOverride
      || (await readSetting(ctx, 'threads_posting_profile'))
      || (await readSetting(ctx, 'x_posting_profile'));
    const handleHint = profileHint
      ? null
      : (await readSetting(ctx, 'threads_posting_handle'))
        || (await readSetting(ctx, 'x_posting_handle'));

    const target = (profileHint && findProfileByIdentity(profiles, profileHint))
      || (handleHint && profileByHandleHint(profiles, handleHint))
      || profiles.find((p) => !!p.email)
      || profiles[0];

    // ---- 2. Ensure Chrome + reuse-or-open profile tab → browserContextId ----
    // Restrict reuse to agent-owned tabs only (ownershipMode: 'ours') so
    // we never hijack a threads.com tab the human is actively using.
    // If no owned tab exists, openProfileWindow creates a fresh one and
    // we mark it owned so subsequent ticks reuse it. `freshTargetId` is
    // set ONLY when we opened the tab ourselves in THIS call; the
    // finally block closes it after compose so tabs don't leak.
    // Owner string for claim scoping — see x-posting-executor for
    // rationale. Scopes the CDP attach to this task so a concurrent
    // task on the same profile can't clobber our session.
    const claimOwner = ctx.taskId;
    let expectedBrowserContextId: string | undefined;
    let freshTargetId: string | null = null;
    try {
      await ensureDebugChrome({ preferredProfile: target.directory });
      const existing = await findExistingTabForHost('threads.com', { ownershipMode: 'ours' });
      if (existing) {
        expectedBrowserContextId = existing.browserContextId ?? undefined;
      } else {
        const opened = await openProfileWindow({
          profileDir: target.directory,
          url: 'https://www.threads.com/',
        });
        expectedBrowserContextId = opened.browserContextId ?? undefined;
        freshTargetId = opened.targetId;
        const claim = claimTarget(
          { profileDir: target.directory, targetId: opened.targetId },
          claimOwner,
        );
        if (!claim) {
          logger.warn(
            { targetId: opened.targetId.slice(0, 8), profileDir: target.directory, owner: claimOwner },
            '[threads-posting-executor] freshly opened tab already claimed by another owner — racing task likely; closing and bailing',
          );
          await closeTabById(opened.targetId);
          return { content: 'Error: Couldn\'t claim threads.com tab (racing task holds it). Retry.', is_error: true };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: Couldn't open Chrome profile for Threads: ${msg}`, is_error: true };
    }

    // ---- 3. Read expected handle for identity verification ----
    const expectedHandleRaw = (await readSetting(ctx, 'threads_posting_handle'))
      || (await readSetting(ctx, 'x_posting_handle'));
    const expectedHandle = expectedHandleRaw ? expectedHandleRaw.replace(/^@/, '') : undefined;

    // ---- 4. Dispatch to the matching composer ----
    // Dry-run default flips with runtime_settings.deliverable_executor_live.
    // Mirrors xPostingExecutor: live flag on → agent tool-calls that
    // omit dry_run publish for real (cadence path); live flag off →
    // default stays dry_run=true for chat safety. Explicit input.dry_run
    // always wins.
    const liveFlag = await readLiveMode(ctx);
    const dryRun = typeof input.dry_run === 'boolean' ? input.dry_run : !liveFlag;
    let result: {
      success: boolean;
      message: string;
      screenshotBase64?: string;
      postsTyped?: number;
      postsPublished?: number;
      currentUrl?: string;
      handle?: string;
      replyTyped?: number;
      replyPublished?: number;
      threads?: unknown[];
    } | undefined;
    const timeoutMs = TOOL_TIMEOUT_MS[toolName] ?? DEFAULT_TOOL_TIMEOUT_MS;

    try {
      result = await withTimeout(`threads-posting:${toolName}`, timeoutMs, async () => {
        if (toolName === 'threads_compose_post') {
          return composeThreadsPostViaBrowser({
            text: String(input.text || ''),
            dryRun,
            expectedHandle,
            expectedBrowserContextId,
          });
        }
        if (toolName === 'threads_compose_thread') {
          const posts = Array.isArray(input.posts) ? (input.posts as string[]) : [];
          return composeThreadsThreadViaBrowser({ posts, dryRun, expectedHandle, expectedBrowserContextId });
        }
        if (toolName === 'threads_scan_posts') {
          const scanned = await scanThreadsPostsViaBrowser({
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
            threads: scanned.posts as unknown[],
          };
        }
        if (toolName === 'threads_compose_reply') {
          return composeThreadsReplyViaBrowser({
            replyToUrl: String(input.reply_to_url || ''),
            text: String(input.text || ''),
            dryRun,
            expectedHandle,
            expectedBrowserContextId,
            db: ctx.db,
            workspaceId: ctx.workspaceId,
          });
        }
        if (toolName === 'threads_delete_reply') {
          const del = await deleteThreadsReplyViaBrowser({
            postUrl: String(input.post_url || ''),
            authorHandle: String(input.author_handle || ''),
            containsText: typeof input.contains_text === 'string' ? input.contains_text : undefined,
            index: typeof input.index === 'number' ? input.index : undefined,
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
        // threads_read_profile
        return readThreadsProfileViaBrowser({ expectedBrowserContextId });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof TimeoutError) {
        logger.error(
          { tool: toolName, timeoutMs, elapsedMs: err.elapsedMs },
          '[threads-posting-executor] composer exceeded timeout',
        );
        return {
          content: `Error: ${toolName} timed out after ${timeoutMs}ms. Task should retry or check Chrome state.`,
          is_error: true,
        };
      }
      logger.error({ err: msg, tool: toolName }, '[threads-posting-executor] handler crashed');
      return { content: `Error: threads-posting handler crashed: ${msg}`, is_error: true };
    } finally {
      // Keep owned tabs alive for reuse across ticks. Mirror of the
      // x-posting executor: the ownership registry + 'ours' lookup
      // ensures at most one owned threads.com tab per daemon, and the
      // next tick attaches to it instead of flashing a new one. On
      // compose error (result unassigned, or success=false), close
      // the tab so a broken tab can't permanently block future ticks.
      if (freshTargetId) {
        const composeFailed = !result || result.success === false;
        if (composeFailed) {
          await closeTabById(freshTargetId);
        }
      }
      // Release task-scoped claims so the next task run can re-claim
      // the same tab. Safe to call when no claim exists (returns 0).
      releaseAllForOwner(claimOwner);
    }

    // ---- 5. Shape the result for the agent ----
    const envelope: Record<string, unknown> = {
      success: result.success,
      message: result.message,
    };
    if (result.currentUrl) envelope.currentUrl = result.currentUrl;
    if (result.postsTyped !== undefined) envelope.postsTyped = result.postsTyped;
    if (result.postsPublished !== undefined) envelope.postsPublished = result.postsPublished;
    if (result.replyTyped !== undefined) envelope.replyTyped = result.replyTyped;
    if (result.replyPublished !== undefined) envelope.replyPublished = result.replyPublished;
    if (result.handle !== undefined) envelope.handle = result.handle;
    if (result.threads !== undefined) envelope.threads = result.threads;
    envelope.dry_run = dryRun;
    envelope.profile_used = target.email || target.directory;

    return {
      content: JSON.stringify(envelope),
      is_error: !result.success,
    };
  },
};
