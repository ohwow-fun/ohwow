/**
 * Generic social platform executor factory.
 *
 * Extracts the identical Chrome lifecycle + profile resolution + tab
 * acquisition + withTabRecovery + withTimeout plumbing that was duplicated
 * verbatim across x-posting-executor.ts and threads-posting-executor.ts.
 *
 * Adding a new platform (LinkedIn, Reddit, etc.) is now:
 *   1. Define a `PlatformConfig` — tool names, settings keys, host, home URL.
 *   2. Define a `ComposerMap` — map each tool name to its composer function.
 *   3. `export const myExecutor = createSocialExecutor(config, composers)`.
 *   No Chrome lifecycle or profile logic to write.
 *
 * Design notes:
 *   - `ComposerFn` receives a `ComposerContext` with all resolved values
 *     (expectedBrowserContextId, profileDir, expectedHandle, dryRun, db,
 *     workspaceId) so composers never need to re-derive them.
 *   - The result envelope is built generically: every field in the
 *     ComposerResult beyond { success, message, screenshotBase64 } is
 *     forwarded to the agent as-is. Platform-specific field names
 *     (tweetsTyped, postsPublished, handle, ...) flow through automatically.
 *   - Ownership mode ('ours' vs 'any') is per-tool: if the tool name is in
 *     `config.dmToolNames`, we allow any existing tab; otherwise agent-only.
 */

import type { ToolExecutor, ToolExecutionContext, ToolCallResult } from './types.js';
import {
  ensureDebugChrome,
  findProfileByIdentity,
  listProfiles,
  openProfileWindow,
  findExistingTabForHost,
  findReusableTabForHost,
  closeTabById,
  resolveBrowserContextForProfile,
} from '../browser/chrome-profile-router.js';
import { claimTarget, releaseAllForOwner } from '../browser/browser-claims.js';
import { withProfileLock } from '../browser/profile-mutex.js';
import { withTabRecovery } from '../browser/tab-recovery.js';
import { profileByHandleHint } from '../browser/chrome-lifecycle.js';
import { logger } from '../../lib/logger.js';
import { withTimeout, TimeoutError } from '../../lib/with-timeout.js';
import { insertCdpTraceEvent } from '../browser/cdp-trace-store.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration that makes a platform unique. Everything else is generic. */
export interface PlatformConfig {
  /** Short identifier used in log tags and error messages. e.g. 'x', 'threads' */
  id: string;
  /** Human-readable name for error messages. e.g. 'X (Twitter)', 'Threads' */
  displayName: string;
  /** All tool names this executor handles. */
  toolNames: ReadonlySet<string>;
  /**
   * Subset of toolNames that may attach to operator-owned tabs in addition
   * to agent-owned ones (DM/list tools that benefit from an open conversation).
   */
  dmToolNames?: ReadonlySet<string>;
  /** runtime_settings key for explicit profile override. e.g. 'x_posting_profile' */
  settingsProfileKey: string;
  /** runtime_settings key for handle-derived profile lookup. e.g. 'x_posting_handle' */
  settingsHandleKey: string;
  /** Fallback settings keys checked when the primary keys are unset. */
  settingsProfileKeyFallback?: string;
  settingsHandleKeyFallback?: string;
  /** Hostname fragment for tab matching. e.g. 'x.com', 'threads.com' */
  hostMatch: string;
  /** URL opened in a fresh profile window. e.g. 'https://x.com/home' */
  homeUrl: string;
  /** Per-tool timeout overrides in ms. */
  toolTimeouts: Readonly<Record<string, number>>;
  /** Fallback timeout when a tool has no explicit entry. */
  defaultTimeoutMs: number;
}

/** Values pre-resolved by the executor, passed into every composer call. */
export interface ComposerContext {
  expectedBrowserContextId: string | undefined;
  profileDir: string;
  expectedHandle: string | undefined;
  dryRun: boolean;
  db: ToolExecutionContext['db'];
  workspaceId: string;
}

export type ComposerResult = {
  success: boolean;
  message: string;
  screenshotBase64?: string;
};

/** A function that performs one tool action in the browser. */
export type ComposerFn = (
  input: Record<string, unknown>,
  ctx: ComposerContext,
) => Promise<ComposerResult>;

/** Maps every tool name the platform supports to its implementation. */
export type ComposerMap = Record<string, ComposerFn>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSocialExecutor(
  config: PlatformConfig,
  composers: ComposerMap,
): ToolExecutor {
  const {
    id,
    displayName,
    toolNames,
    dmToolNames,
    settingsProfileKey,
    settingsHandleKey,
    settingsProfileKeyFallback,
    settingsHandleKeyFallback,
    hostMatch,
    homeUrl,
    toolTimeouts,
    defaultTimeoutMs,
  } = config;
  const logTag = `${id}-executor`;

  return {
    canHandle(toolName: string): boolean {
      return toolNames.has(toolName);
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
          content: `Error: No Chrome profiles found in ~/.ohwow/chrome-debug/. Log into ${displayName} in desktop Chrome, run 'ohwow chrome bootstrap', then retry.`,
          is_error: true,
        };
      }

      const profileOverride = typeof input.profile === 'string' && input.profile.trim().length > 0
        ? input.profile.trim()
        : null;

      const profileHint = profileOverride
        || (await readSetting(ctx, settingsProfileKey))
        || (settingsProfileKeyFallback ? await readSetting(ctx, settingsProfileKeyFallback) : null);

      const handleHint = profileHint
        ? null
        : (await readSetting(ctx, settingsHandleKey))
          || (settingsHandleKeyFallback ? await readSetting(ctx, settingsHandleKeyFallback) : null);

      const target = (profileHint && findProfileByIdentity(profiles, profileHint))
        || (handleHint && profileByHandleHint(profiles, handleHint))
        || profiles.find((p) => !!p.email)
        || profiles[0];

      // ---- 2. Chrome lifecycle + tab acquisition ----
      const ownershipMode = dmToolNames?.has(toolName) ? 'any' : 'ours';
      const claimOwner = ctx.taskId;
      let freshTargetId: string | null = null;

      async function acquireTab(): Promise<{
        page: { expectedBrowserContextId: string | undefined };
        targetId: string;
        release: () => void;
      }> {
        releaseAllForOwner(claimOwner);
        freshTargetId = null;
        let localContextId: string | undefined;
        let localFreshTargetId: string | null = null;

        await withProfileLock(target.directory, async () => {
          await ensureDebugChrome({ preferredProfile: target.directory });

          const expectedContext = resolveBrowserContextForProfile(target.directory);
          const reusable = expectedContext
            ? await findReusableTabForHost({
              hostMatch,
              profileDir: target.directory,
              owner: claimOwner,
              resetUrl: homeUrl,
              expectedBrowserContextId: expectedContext,
            })
            : null;

          if (reusable) {
            localContextId = reusable.browserContextId ?? undefined;
            logger.info(
              { cdp: true, action: 'reuse:hit', profile: target.directory, owner: claimOwner, contextId: localContextId },
              `[${logTag}] reusing existing ${hostMatch} tab`,
            );
            insertCdpTraceEvent({ action: 'reuse:hit', profile: target.directory, owner: claimOwner, contextId: localContextId });
            reusable.page.close();
            reusable.closeBrowser();
            return;
          }

          // DM-mode: also accept an operator's open tab
          if (ownershipMode === 'any') {
            const operatorTab = await findExistingTabForHost(hostMatch, { ownershipMode: 'any' });
            if (operatorTab) {
              localContextId = operatorTab.browserContextId ?? undefined;
              return;
            }
          }

          // Open a fresh profile window
          const opened = await openProfileWindow({
            profileDir: target.directory,
            url: homeUrl,
          });
          localContextId = opened.browserContextId ?? undefined;
          localFreshTargetId = opened.targetId;

          logger.info(
            { cdp: true, action: 'tab:open', profile: target.directory, targetId: opened.targetId, owner: claimOwner },
            `[${logTag}] opened fresh ${hostMatch} tab`,
          );
          insertCdpTraceEvent({ action: 'tab:open', profile: target.directory, targetId: opened.targetId, owner: claimOwner });

          const claim = claimTarget(
            { profileDir: target.directory, targetId: opened.targetId },
            claimOwner,
          );
          if (!claim) {
            logger.warn(
              { targetId: opened.targetId.slice(0, 8), profileDir: target.directory, owner: claimOwner },
              `[${logTag}] freshly opened tab already claimed by another owner — racing task; closing and bailing`,
            );
            await closeTabById(opened.targetId);
            throw new Error(`Couldn't claim ${hostMatch} tab (racing task holds it). Retry.`);
          }
        });

        freshTargetId = localFreshTargetId;
        return {
          page: { expectedBrowserContextId: localContextId },
          targetId: localFreshTargetId ?? 'reused',
          release: () => { releaseAllForOwner(claimOwner); },
        };
      }

      // ---- 3. Resolve expected handle for identity verification ----
      const expectedHandleRaw = (await readSetting(ctx, settingsHandleKey))
        || (settingsHandleKeyFallback ? await readSetting(ctx, settingsHandleKeyFallback) : null);
      const expectedHandle = expectedHandleRaw ? expectedHandleRaw.replace(/^@/, '') : undefined;

      // ---- 4. Resolve dry-run flag ----
      const liveFlag = await readLiveMode(ctx);
      const dryRun = typeof input.dry_run === 'boolean' ? input.dry_run : !liveFlag;

      // ---- 5. Dispatch to composer via withTabRecovery + withTimeout ----
      const timeoutMs = toolTimeouts[toolName] ?? defaultTimeoutMs;
      let result: ComposerResult | undefined;

      try {
        logger.debug({ tool: toolName, taskId: ctx.taskId }, `[${logTag}] acquiring ${hostMatch} tab`);

        result = await withTabRecovery(
          { acquire: acquireTab, label: `${id}-posting`, maxRetries: 2 },
          async ({ expectedBrowserContextId }) => {
            logger.debug(
              { tool: toolName, taskId: ctx.taskId, ctx: expectedBrowserContextId?.slice(0, 8) },
              `[${logTag}] tab acquired; dispatching composer`,
            );

            const composerFn = composers[toolName];
            if (!composerFn) {
              return {
                success: false,
                message: `No composer registered for tool "${toolName}" on platform "${id}".`,
              };
            }

            return withTimeout(`${id}-posting:${toolName}`, timeoutMs, () =>
              composerFn(input, {
                expectedBrowserContextId,
                profileDir: target.directory,
                expectedHandle,
                dryRun,
                db: ctx.db,
                workspaceId: ctx.workspaceId,
              }),
            );
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof TimeoutError) {
          logger.error(
            { tool: toolName, timeoutMs, elapsedMs: err.elapsedMs },
            `[${logTag}] composer exceeded timeout — likely Chrome crash, login redirect loop, or selector hang`,
          );
          return {
            content: `Error: ${toolName} timed out after ${timeoutMs}ms (likely Chrome crash, login redirect loop, or selector hang). Task should retry or check Chrome state.`,
            is_error: true,
          };
        }
        logger.error({ err: msg, tool: toolName }, `[${logTag}] composer handler crashed`);
        return { content: `Error: ${id} handler crashed: ${msg}`, is_error: true };
      } finally {
        // Close the tab we opened if the compose failed — a broken tab
        // in the registry blocks future ticks. On success, keep it alive
        // so the next cadence fire reuses it without another window-open.
        if (freshTargetId) {
          const composeFailed = !result || result.success === false;
          if (composeFailed) await closeTabById(freshTargetId);
        }
        releaseAllForOwner(claimOwner);
      }

      // ---- 6. Shape result envelope ----
      // Cast through Record to spread platform-specific fields (tweetsTyped,
      // postsPublished, handle, etc.) without requiring ComposerResult to
      // carry an index signature (which would break structural assignability
      // from specific return types like ComposeResult, ReplyXResult, etc.).
      const { success, message, screenshotBase64: _screenshot, ...rest } =
        result as ComposerResult & Record<string, unknown>;
      const envelope: Record<string, unknown> = {
        success,
        message,
        dry_run: dryRun,
        profile_used: target.email || target.directory,
        ...rest,
      };

      return {
        content: JSON.stringify(envelope),
        is_error: !success,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
