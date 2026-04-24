/**
 * X (Twitter) posting executor — task-agent dispatch for x_compose_tweet,
 * x_compose_thread, x_compose_article, x_send_dm, x_list_dms,
 * x_delete_tweet, x_scan_posts, x_compose_reply, x_delete_reply.
 *
 * Chrome lifecycle, profile resolution, tab acquisition, withTabRecovery,
 * and withTimeout are all handled by `createSocialExecutor` in
 * social-executor.ts. This file only defines what is X-specific:
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

// ---------------------------------------------------------------------------
// Platform config
// ---------------------------------------------------------------------------

const xConfig: PlatformConfig = {
  id: 'x',
  displayName: 'X (Twitter)',
  toolNames: new Set([
    'x_compose_tweet',
    'x_compose_thread',
    'x_compose_article',
    'x_send_dm',
    'x_list_dms',
    'x_delete_tweet',
    'x_scan_posts',
    'x_compose_reply',
    'x_delete_reply',
  ]),
  dmToolNames: new Set(['x_send_dm', 'x_list_dms', 'x_delete_reply', 'x_delete_tweet']),
  settingsProfileKey: 'x_posting_profile',
  settingsHandleKey: 'x_posting_handle',
  hostMatch: 'x.com',
  homeUrl: 'https://x.com/home',
  toolTimeouts: {
    x_compose_tweet: 90_000,
    x_compose_thread: 180_000,
    x_compose_article: 240_000,
    x_send_dm: 60_000,
    x_list_dms: 30_000,
    x_delete_tweet: 60_000,
    x_scan_posts: 45_000,
    x_compose_reply: 90_000,
    x_delete_reply: 60_000,
  },
  defaultTimeoutMs: 90_000,
};

// ---------------------------------------------------------------------------
// Composer map
// ---------------------------------------------------------------------------

const xComposers: ComposerMap = {
  async x_compose_tweet(input, ctx: ComposerContext) {
    return composeTweetViaBrowser({
      text: String(input.text || ''),
      dryRun: ctx.dryRun,
      expectedHandle: ctx.expectedHandle,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      profileDir: ctx.profileDir,
    });
  },

  async x_compose_thread(input, ctx: ComposerContext) {
    const tweets = Array.isArray(input.tweets) ? (input.tweets as string[]) : [];
    return composeThreadViaBrowser({
      tweets,
      dryRun: ctx.dryRun,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      profileDir: ctx.profileDir,
    });
  },

  async x_compose_article(input, ctx: ComposerContext) {
    return composeArticleViaBrowser({
      title: String(input.title || ''),
      body: String(input.body || ''),
      dryRun: ctx.dryRun,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      profileDir: ctx.profileDir,
    });
  },

  async x_send_dm(input, ctx: ComposerContext) {
    return sendDmViaBrowser({
      conversationPair: input.conversation_pair as string | undefined,
      handle: input.handle as string | undefined,
      text: String(input.text || ''),
      dryRun: ctx.dryRun,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      profileDir: ctx.profileDir,
    });
  },

  async x_list_dms(input, ctx: ComposerContext) {
    const listed = await listDmsViaBrowser({
      limit: input.limit as number | undefined,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      profileDir: ctx.profileDir,
    });
    return {
      success: listed.success,
      message: listed.message,
      screenshotBase64: listed.screenshotBase64,
      threads: listed.threads as unknown[],
    };
  },

  async x_scan_posts(input, ctx: ComposerContext) {
    const scanned = await scanXPostsViaBrowser({
      source: String(input.source || ''),
      limit: typeof input.limit === 'number' ? input.limit : undefined,
      scrollRounds: typeof input.scroll_rounds === 'number' ? input.scroll_rounds : undefined,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
    });
    return {
      success: scanned.success,
      message: scanned.message,
      screenshotBase64: scanned.screenshotBase64,
      currentUrl: scanned.currentUrl,
      threads: scanned.tweets as unknown[],
    };
  },

  async x_compose_reply(input, ctx: ComposerContext) {
    return composeTweetReplyViaBrowser({
      replyToUrl: String(input.reply_to_url || ''),
      text: String(input.text || ''),
      dryRun: ctx.dryRun,
      expectedHandle: ctx.expectedHandle,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      db: ctx.db,
      workspaceId: ctx.workspaceId,
    });
  },

  async x_delete_reply(input, ctx: ComposerContext) {
    return deleteXReplyViaBrowser({
      postUrl: String(input.post_url || ''),
      authorHandle: String(input.author_handle || ''),
      containsText: typeof input.contains_text === 'string' ? input.contains_text : undefined,
      dryRun: ctx.dryRun,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
    });
  },

  async x_delete_tweet(input, ctx: ComposerContext) {
    return deleteLastTweetViaBrowser({
      handle: String(input.handle || ''),
      marker: String(input.marker || ''),
      dryRun: ctx.dryRun,
      expectedBrowserContextId: ctx.expectedBrowserContextId,
      profileDir: ctx.profileDir,
    });
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const xPostingExecutor = createSocialExecutor(xConfig, xComposers);
