/**
 * DeliverableExecutor — executes the real-world action associated with an
 * approved deliverable.
 *
 * Background: before this module existed, approving a task flipped its status
 * to 'approved' and parked the deliverable in 'approved' but nothing actually
 * fired the underlying action (post a tweet, send an email, etc.). Content
 * piled up with no bridge between "human reviewed" and "thing happened".
 *
 * Design:
 *   - Handlers are registered by `deferred_action.type`.
 *   - Called from two sites: approvals.ts (post-approval) and
 *     task-completion.ts (trust-output path).
 *   - On success, the deliverable transitions approved -> delivered and
 *     delivery_result captures the handler's return value. On failure the
 *     deliverable stays in 'approved' and delivery_result records the error,
 *     so retries are possible.
 *   - Defaults to dry-run mode for safety. Flip runtime_settings
 *     `deliverable_executor_live` = "true" to perform real external actions.
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';
import { composeTweetViaBrowser } from '../orchestrator/tools/x-posting.js';
import { ensureDebugChrome, findProfileByIdentity, listProfiles, openProfileWindow } from './browser/chrome-profile-router.js';
import { profileByHandleHint } from './browser/chrome-lifecycle.js';

export interface DeliverableRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  deliverable_type: string;
  provider: string | null;
  content: string;
  status: string;
}

export interface ExecutorContext {
  db: DatabaseAdapter;
  liveMode: boolean;
}

export interface HandlerResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

type Handler = (
  content: Record<string, unknown>,
  ctx: ExecutorContext,
) => Promise<HandlerResult>;

export class DeliverableExecutor {
  private handlers = new Map<string, Handler>();
  constructor(private db: DatabaseAdapter) {
    this.register('post_tweet', postTweetHandler);
  }

  register(actionType: string, handler: Handler): void {
    this.handlers.set(actionType, handler);
  }

  /**
   * Resolve and run the handler for a deliverable. Updates the deliverable
   * row in place: on success marks it delivered with delivery_result; on
   * failure leaves status untouched and records the error in delivery_result.
   */
  async execute(deliverableId: string): Promise<HandlerResult> {
    const { data } = await this.db.from('agent_workforce_deliverables')
      .select('*')
      .eq('id', deliverableId)
      .maybeSingle();
    const row = data as DeliverableRow | null;
    if (!row) return { ok: false, error: 'deliverable not found' };

    const content = parseContent(row.content);
    const actionType = inferActionType(row, content);
    if (!actionType) {
      return { ok: false, error: 'no action_spec or inferrable action type' };
    }

    const handler = this.handlers.get(actionType);
    if (!handler) {
      return { ok: false, error: `no handler registered for ${actionType}` };
    }

    const liveMode = await readLiveMode(this.db);
    const ctx: ExecutorContext = { db: this.db, liveMode };

    let outcome: HandlerResult;
    try {
      outcome = await handler(content, ctx);
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      delivery_result: JSON.stringify({ ...outcome, actionType, liveMode, at: now }),
      updated_at: now,
    };
    if (outcome.ok) {
      patch.status = 'delivered';
      patch.delivered_at = now;
    }
    await this.db.from('agent_workforce_deliverables')
      .update(patch)
      .eq('id', deliverableId);

    logger.info({ deliverableId, actionType, liveMode, ok: outcome.ok }, '[DeliverableExecutor] execute');
    return outcome;
  }

  /**
   * Convenience: execute the deliverable(s) linked to a task. Used from the
   * approve endpoint and from the trust-output path after a task completes.
   */
  async executeForTask(taskId: string): Promise<HandlerResult[]> {
    const { data } = await this.db.from('agent_workforce_deliverables')
      .select('id,status')
      .eq('task_id', taskId);
    const rows = (data as Array<{ id: string; status: string }>) ?? [];
    const results: HandlerResult[] = [];
    for (const r of rows) {
      if (r.status !== 'approved') continue;
      results.push(await this.execute(r.id));
    }
    return results;
  }
}

function parseContent(raw: unknown): Record<string, unknown> {
  // The DB adapter sometimes returns TEXT JSON columns already parsed as
  // objects; handle both shapes so the handler sees a consistent object.
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Prefer an explicit action_spec in the deliverable content; otherwise infer
 * from provider + deliverable_type. Keeps back-compat with the existing
 * {text} deliverables while letting new dispatchers be explicit.
 */
function inferActionType(row: DeliverableRow, content: Record<string, unknown>): string | null {
  const spec = content.action_spec as Record<string, unknown> | undefined;
  if (spec && typeof spec.type === 'string') return spec.type;
  if (row.provider === 'x') return 'post_tweet';
  return null;
}

async function readLiveMode(db: DatabaseAdapter): Promise<boolean> {
  try {
    const { data } = await db.from('runtime_settings')
      .select('value')
      .eq('key', 'deliverable_executor_live')
      .maybeSingle();
    const val = (data as { value: string } | null)?.value;
    return val === 'true' || val === '1';
  } catch { return false; }
}

async function readPreferredXProfile(db: DatabaseAdapter): Promise<string | null> {
  try {
    const { data } = await db.from('runtime_settings')
      .select('value')
      .eq('key', 'x_posting_profile')
      .maybeSingle();
    const val = (data as { value: string } | null)?.value;
    return val && val.trim().length > 0 ? val.trim() : null;
  } catch { return null; }
}

/**
 * runtime_settings.x_posting_handle (e.g. "example_handle") pins the expected
 * @handle that should be signed into the chosen Chrome profile. Used as
 * a hard check before composeTweetViaBrowser types anything. Optional —
 * when unset, we post without identity verification and rely on the
 * profile routing (less safe; logged in the result).
 */
async function readExpectedXHandle(db: DatabaseAdapter): Promise<string | null> {
  try {
    const { data } = await db.from('runtime_settings')
      .select('value')
      .eq('key', 'x_posting_handle')
      .maybeSingle();
    const val = (data as { value: string } | null)?.value;
    return val && val.trim().length > 0 ? val.trim().replace(/^@/, '') : null;
  } catch { return null; }
}

/**
 * Make sure debug Chrome is up on :9222 with the target profile's
 * window open *before* x-posting attaches over CDP. The tool-executor
 * path does this via `ctx.browserState.activate()`, but the
 * deliverable-executor runs outside that surface — previously it went
 * straight to `composeTweetViaBrowser`, which called
 * `chromium.connectOverCDP(:9222)` against a debug Chrome that may not
 * be running. Playwright would then either fail to attach or, worse,
 * fall through some upstream capability and launch its own bundled
 * Chromium with no persistent profile — meaning we tried to post
 * logged out.
 */
async function ensureProfileChrome(
  db: DatabaseAdapter,
): Promise<{ ok: true; browserContextId: string | null } | { ok: false; error: string }> {
  const override = await readPreferredXProfile(db);
  const expectedHandle = await readExpectedXHandle(db);
  const profiles = listProfiles();
  if (profiles.length === 0) {
    return { ok: false, error: 'no profiles in ~/.ohwow/chrome-cdp/. Log into X in desktop Chrome once via the onboarding, or set runtime_settings.x_posting_profile.' };
  }
  // Preference order:
  //   1. explicit runtime_settings.x_posting_profile override
  //   2. handle-derived match — when only x_posting_handle is set, try to
  //      correlate it to a profile by email/localname. Without this the
  //      fallback picks whichever profile Chrome lists first (alphabetical
  //      / Default), which on multi-profile rigs is almost never the
  //      intended X account.
  //   3. first profile with an email
  //   4. first profile overall
  const handleDerived = expectedHandle ? profileByHandleHint(profiles, expectedHandle) : null;
  const target = (override && findProfileByIdentity(profiles, override))
    || handleDerived
    || profiles.find((p) => !!p.email)
    || profiles[0];
  try {
    await ensureDebugChrome({ preferredProfile: target.directory });
    // ensureDebugChrome only guarantees the process is running; it does
    // not guarantee a window for THIS profile is open. openProfileWindow
    // is idempotent — it no-ops if the window already exists. We return
    // its browserContextId so x-posting can attach to a tab in THIS
    // profile's context, not just any x.com tab in CDP.
    // url='https://x.com/home' guarantees `open -a` creates a fresh tab
    // (needed when the profile window is already open — without a URL
    // arg Chrome just focuses it and no new CDP target appears). The
    // tab lands in the intended profile's browserContextId, which is
    // the handle x-posting uses to pin its CDP attach.
    const opened = await openProfileWindow({
      profileDir: target.directory,
      url: 'https://x.com/home',
    });
    return { ok: true, browserContextId: opened.browserContextId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const postTweetHandler: Handler = async (content, ctx) => {
  const text = typeof content.text === 'string' ? content.text.trim() : '';
  if (!text) return { ok: false, error: 'post_tweet: content.text missing' };
  const dryRun = !ctx.liveMode;

  const prep = await ensureProfileChrome(ctx.db);
  if (!prep.ok) return { ok: false, error: `post_tweet: ${prep.error}` };

  const expectedHandle = await readExpectedXHandle(ctx.db);
  try {
    const res = await composeTweetViaBrowser({
      text,
      dryRun,
      expectedHandle: expectedHandle || undefined,
      expectedBrowserContextId: prep.browserContextId || undefined,
    });
    // Duplicate-blocked is "the bytes are already out there" — not a
    // real failure. Returning ok:true advances the approvals queue
    // (the draft gets marked consumed) and prevents the infinite
    // retry loop that hits X's duplicate-content gate on every tick.
    if (!res.success && res.duplicateBlocked === true) {
      return {
        ok: true,
        result: { dryRun, expectedHandle, duplicateBlocked: true, ...(res as unknown as Record<string, unknown>) },
      };
    }
    if (!res.success) {
      return { ok: false, error: res.message || 'compose failed', result: res as unknown as Record<string, unknown> };
    }
    return { ok: true, result: { dryRun, expectedHandle, ...(res as unknown as Record<string, unknown>) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};
