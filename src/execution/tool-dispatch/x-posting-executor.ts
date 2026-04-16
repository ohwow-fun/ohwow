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
  ensureDebugChrome,
  findProfileByIdentity,
  listProfiles,
  openProfileWindow,
} from '../browser/chrome-profile-router.js';
import { profileByHandleHint } from '../browser/chrome-lifecycle.js';
import { logger } from '../../lib/logger.js';

const X_POSTING_TOOL_NAMES = new Set([
  'x_compose_tweet',
  'x_compose_thread',
  'x_compose_article',
  'x_send_dm',
  'x_list_dms',
  'x_delete_tweet',
]);

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

    // ---- 2. Ensure Chrome + open profile window → browserContextId ----
    let expectedBrowserContextId: string | undefined;
    try {
      await ensureDebugChrome({ preferredProfile: target.directory });
      const opened = await openProfileWindow({
        profileDir: target.directory,
        url: 'https://x.com/home',
      });
      expectedBrowserContextId = opened.browserContextId ?? undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: Couldn't open Chrome profile for X: ${msg}`, is_error: true };
    }

    // ---- 3. Read expected handle for identity verification ----
    const expectedHandleRaw = await readSetting(ctx, 'x_posting_handle');
    const expectedHandle = expectedHandleRaw ? expectedHandleRaw.replace(/^@/, '') : undefined;

    // ---- 4. Dispatch to the matching composer ----
    const dryRun = input.dry_run !== false; // default dry_run=true
    let result: {
      success: boolean;
      message: string;
      screenshotBase64?: string;
      tweetsTyped?: number;
      tweetsPublished?: number;
      currentUrl?: string;
      landedAt?: string;
      threads?: unknown[];
    };
    try {
      if (toolName === 'x_compose_tweet') {
        result = await composeTweetViaBrowser({
          text: String(input.text || ''),
          dryRun,
          expectedHandle,
          expectedBrowserContextId,
        });
      } else if (toolName === 'x_compose_thread') {
        const tweets = Array.isArray(input.tweets) ? (input.tweets as string[]) : [];
        result = await composeThreadViaBrowser({ tweets, dryRun, expectedBrowserContextId });
      } else if (toolName === 'x_compose_article') {
        result = await composeArticleViaBrowser({
          title: String(input.title || ''),
          body: String(input.body || ''),
          dryRun,
          expectedBrowserContextId,
        });
      } else if (toolName === 'x_send_dm') {
        result = await sendDmViaBrowser({
          conversationPair: input.conversation_pair as string | undefined,
          handle: input.handle as string | undefined,
          text: String(input.text || ''),
          dryRun,
          expectedBrowserContextId,
        });
      } else if (toolName === 'x_list_dms') {
        const listed = await listDmsViaBrowser({
          limit: input.limit as number | undefined,
          expectedBrowserContextId,
        });
        result = {
          success: listed.success,
          message: listed.message,
          screenshotBase64: listed.screenshotBase64,
          threads: listed.threads as unknown[],
        };
      } else {
        // x_delete_tweet
        result = await deleteLastTweetViaBrowser({
          handle: String(input.handle || ''),
          marker: String(input.marker || ''),
          dryRun,
          expectedBrowserContextId,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err: msg, tool: toolName },
        '[x-posting-executor] composer handler crashed',
      );
      return { content: `Error: x-posting handler crashed: ${msg}`, is_error: true };
    }

    // ---- 5. Shape the result for the agent ----
    const envelope: Record<string, unknown> = {
      success: result.success,
      message: result.message,
    };
    if (result.currentUrl) envelope.currentUrl = result.currentUrl;
    if (result.tweetsTyped !== undefined) envelope.tweetsTyped = result.tweetsTyped;
    if (result.tweetsPublished !== undefined) envelope.tweetsPublished = result.tweetsPublished;
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
