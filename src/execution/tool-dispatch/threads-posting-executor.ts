/**
 * Threads posting executor — task-agent dispatch for threads_compose_post,
 * threads_compose_thread, threads_read_profile, threads_scan_posts,
 * threads_compose_reply, threads_delete_reply.
 *
 * Chrome lifecycle, profile resolution, tab acquisition, withTabRecovery,
 * and withTimeout are all handled by `createSocialExecutor` in
 * social-executor.ts. This file only defines what is Threads-specific:
 *   - Which tool names belong to this platform
 *   - Which settings keys resolve the target profile
 *   - The host/home URL for tab acquisition
 *   - Per-tool timeouts
 *   - The composer map: tool name → implementation function
 */

import {
  createSocialExecutor,
  type PlatformConfig,
  type ComposerMap,
  type ComposerContext,
} from './social-executor.js';
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

// ---------------------------------------------------------------------------
// Platform config
// ---------------------------------------------------------------------------

const threadsConfig: PlatformConfig = {
  id: 'threads',
  displayName: 'Threads',
  toolNames: new Set([
    'threads_compose_post',
    'threads_compose_thread',
    'threads_read_profile',
    'threads_scan_posts',
    'threads_compose_reply',
    'threads_delete_reply',
  ]),
  settingsProfileKey: 'threads_posting_profile',
  settingsHandleKey: 'threads_posting_handle',
  settingsProfileKeyFallback: 'x_posting_profile',
  settingsHandleKeyFallback: 'x_posting_handle',
  hostMatch: 'threads.com',
  homeUrl: 'https://www.threads.com/',
  toolTimeouts: {
    threads_compose_post: 90_000,
    threads_compose_thread: 180_000,
    threads_read_profile: 30_000,
    threads_scan_posts: 45_000,
    threads_compose_reply: 90_000,
    threads_delete_reply: 60_000,
  },
  defaultTimeoutMs: 90_000,
};

// ---------------------------------------------------------------------------
// Composer map
// ---------------------------------------------------------------------------

const threadsComposers: ComposerMap = {
  async threads_compose_post(input, ctx: ComposerContext) {
    return composeThreadsPostViaBrowser({
      text: String(input.text || ''),
      dryRun: ctx.dryRun,
      expectedHandle: ctx.expectedHandle,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      profileDir: ctx.profileDir,
    });
  },

  async threads_compose_thread(input, ctx: ComposerContext) {
    const posts = Array.isArray(input.posts) ? (input.posts as string[]) : [];
    return composeThreadsThreadViaBrowser({
      posts,
      dryRun: ctx.dryRun,
      expectedHandle: ctx.expectedHandle,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      profileDir: ctx.profileDir,
    });
  },

  async threads_read_profile(_input, ctx: ComposerContext) {
    return readThreadsProfileViaBrowser({
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      profileDir: ctx.profileDir,
    });
  },

  async threads_scan_posts(input, ctx: ComposerContext) {
    const scanned = await scanThreadsPostsViaBrowser({
      source: String(input.source || ''),
      limit: typeof input.limit === 'number' ? input.limit : undefined,
      scrollRounds: typeof input.scroll_rounds === 'number' ? input.scroll_rounds : undefined,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      profileDir: ctx.profileDir,
    });
    return {
      success: scanned.success,
      message: scanned.message,
      screenshotBase64: scanned.screenshotBase64,
      currentUrl: scanned.currentUrl,
      threads: scanned.posts as unknown[],
    };
  },

  async threads_compose_reply(input, ctx: ComposerContext) {
    return composeThreadsReplyViaBrowser({
      replyToUrl: String(input.reply_to_url || ''),
      text: String(input.text || ''),
      dryRun: ctx.dryRun,
      expectedHandle: ctx.expectedHandle,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      profileDir: ctx.profileDir,
    });
  },

  async threads_delete_reply(input, ctx: ComposerContext) {
    return deleteThreadsReplyViaBrowser({
      postUrl: String(input.post_url || ''),
      authorHandle: String(input.author_handle || ''),
      containsText: typeof input.contains_text === 'string' ? input.contains_text : undefined,
      index: typeof input.index === 'number' ? input.index : undefined,
      dryRun: ctx.dryRun,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      profileDir: ctx.profileDir,
    });
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const threadsPostingExecutor = createSocialExecutor(threadsConfig, threadsComposers);
