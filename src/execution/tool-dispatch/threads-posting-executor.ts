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
  ensureDebugChrome,
  findProfileByIdentity,
  listProfiles,
  openProfileWindow,
} from '../browser/chrome-profile-router.js';
import { profileByHandleHint } from '../browser/chrome-lifecycle.js';
import { logger } from '../../lib/logger.js';
import { withTimeout, TimeoutError } from '../../lib/with-timeout.js';

const THREADS_TOOL_NAMES = new Set([
  'threads_compose_post',
  'threads_compose_thread',
  'threads_read_profile',
]);

const TOOL_TIMEOUT_MS: Record<string, number> = {
  threads_compose_post: 90_000,
  threads_compose_thread: 180_000,
  threads_read_profile: 30_000,
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

    // ---- 2. Ensure Chrome + open profile window → browserContextId ----
    let expectedBrowserContextId: string | undefined;
    try {
      await ensureDebugChrome({ preferredProfile: target.directory });
      const opened = await openProfileWindow({
        profileDir: target.directory,
        url: 'https://www.threads.com/',
      });
      expectedBrowserContextId = opened.browserContextId ?? undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: Couldn't open Chrome profile for Threads: ${msg}`, is_error: true };
    }

    // ---- 3. Read expected handle for identity verification ----
    const expectedHandleRaw = (await readSetting(ctx, 'threads_posting_handle'))
      || (await readSetting(ctx, 'x_posting_handle'));
    const expectedHandle = expectedHandleRaw ? expectedHandleRaw.replace(/^@/, '') : undefined;

    // ---- 4. Dispatch to the matching composer ----
    const dryRun = input.dry_run !== false;
    let result: {
      success: boolean;
      message: string;
      screenshotBase64?: string;
      postsTyped?: number;
      postsPublished?: number;
      currentUrl?: string;
      handle?: string;
    };
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
    }

    // ---- 5. Shape the result for the agent ----
    const envelope: Record<string, unknown> = {
      success: result.success,
      message: result.message,
    };
    if (result.currentUrl) envelope.currentUrl = result.currentUrl;
    if (result.postsTyped !== undefined) envelope.postsTyped = result.postsTyped;
    if (result.postsPublished !== undefined) envelope.postsPublished = result.postsPublished;
    if (result.handle !== undefined) envelope.handle = result.handle;
    envelope.dry_run = dryRun;
    envelope.profile_used = target.email || target.directory;

    return {
      content: JSON.stringify(envelope),
      is_error: !result.success,
    };
  },
};
