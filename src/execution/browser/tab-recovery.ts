/**
 * Tab recovery — layer 2 of the manual-tab-close resilience story.
 *
 * The operator can close an agent's Chrome tab at any moment (by hand,
 * a renderer crash, or a WS drop). Layer 1 (`Target.targetDestroyed`
 * → `releaseByTargetId`) cleans up the orphan claim, but the executor
 * mid-call still sees a raw CDP error and unwinds the whole task.
 *
 * This wrapper closes that gap. On a target-closed error it releases
 * the stale claim, re-runs the acquisition path (which finds a
 * surviving tab or opens a fresh one), and retries the work. Only the
 * curated error fragments below are treated as recoverable; anything
 * else rethrows untouched.
 *
 * Idempotency caveat: retries re-run `fn` from the top. The caller is
 * responsible for making `fn` idempotent or tolerant of partial
 * execution — a tab that closes AFTER the composer submitted but
 * BEFORE we observed the confirmation will cause a double-submit on
 * retry. Layer 3 (state checkpointing) addresses that; for now, accept
 * the risk. Each executor should log its stage boundaries so the retry
 * trail stays auditable.
 */

import { logger } from '../../lib/logger.js';

// ---------------------------------------------------------------------------
// Error matching
// ---------------------------------------------------------------------------

// Substring fragments that indicate the underlying CDP/Playwright target
// disappeared mid-operation. Matched case-insensitively.
const TARGET_CLOSED_FRAGMENTS: readonly string[] = [
  'target closed',
  'target destroyed',
  'session closed',
  'page has been closed',
  'websocket is not open',
  // raw-cdp.ts throws "CDP websocket not open" (no "is"). Match both forms.
  'websocket not open',
  'disconnected from page',
  'connection closed',
  'attached to unexpected target',
];

/**
 * Extract a message string from any thrown value. Error → .message,
 * string → itself, object with .message → .message, otherwise
 * String(err).
 */
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message ?? String(err);
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * True when the error indicates the CDP target backing the current
 * page was destroyed, the WS disconnected, or the session was
 * detached. See TARGET_CLOSED_FRAGMENTS above for the matched
 * substrings (case-insensitive).
 *
 * Additionally matches Chrome DevTools JSON-RPC error objects with
 * `code === -32000` and a message that mentions a closed target.
 */
export function isTargetClosedError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  // CDP JSON-RPC error shape: { code: -32000, message: "..." }. raw-cdp
  // serializes these into an Error whose message is JSON.stringify(err),
  // so the -32000 and a "target...closed" phrase both live inside the
  // extracted message string. Also check the raw object for callers that
  // hand us the JSON-RPC error directly.
  if (typeof err === 'object') {
    const obj = err as { code?: unknown; message?: unknown };
    if (obj.code === -32000 && typeof obj.message === 'string'
      && /target.+closed/i.test(obj.message)) {
      return true;
    }
  }

  const msg = extractMessage(err).toLowerCase();
  if (!msg) return false;
  for (const frag of TARGET_CLOSED_FRAGMENTS) {
    if (msg.includes(frag)) return true;
  }
  // JSON-RPC error serialized into message text (raw-cdp wraps msg.error
  // with JSON.stringify, so the -32000 code shows up as a substring).
  if (msg.includes('-32000') && /target.+closed/.test(msg)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Recovery wrapper
// ---------------------------------------------------------------------------

export interface TabRecoveryOpts<TPage> {
  /**
   * Acquire (or re-acquire) a page handle. Called once on entry and
   * again on each recovery. Implementation should run the full
   * lock → reuse-or-open → claim → reset sequence and return:
   *   - page: whatever handle fn needs (typically a context/target id
   *     bundle; the wrapper treats it opaquely)
   *   - targetId: recorded for logs
   *   - release: idempotent claim release for this attempt
   */
  acquire: () => Promise<{ page: TPage; targetId: string; release: () => void }>;
  /** Default 2 — total attempts = maxRetries + 1 = 3. */
  maxRetries?: number;
  /** Log prefix, e.g. 'x-posting'. Defaults to 'tab-recovery'. */
  label?: string;
}

/**
 * Run `fn` against a page acquired via `opts.acquire`. On a
 * target-closed error, release the attempt's claim and retry up to
 * `maxRetries` times. Non-target-closed errors rethrow immediately.
 *
 * When every attempt hits a target-closed error, the LAST such error
 * is rethrown wrapped with the prefix
 * `"[tab-recovery] gave up after N attempts: "` so operators can
 * distinguish exhausted recovery from a single unrelated failure.
 */
export async function withTabRecovery<TPage, TResult>(
  opts: TabRecoveryOpts<TPage>,
  fn: (page: TPage) => Promise<TResult>,
): Promise<TResult> {
  const maxRetries = opts.maxRetries ?? 2;
  const label = opts.label ?? 'tab-recovery';
  const totalAttempts = maxRetries + 1;

  let lastTargetClosedErr: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const handle = await opts.acquire();
    try {
      const result = await fn(handle.page);
      handle.release();
      return result;
    } catch (err) {
      handle.release();
      if (!isTargetClosedError(err)) {
        // Unrelated failure — propagate untouched.
        throw err;
      }
      lastTargetClosedErr = err;
      if (attempt < totalAttempts) {
        logger.info(
          {
            label,
            attempt,
            maxAttempts: totalAttempts,
            targetId: handle.targetId.slice(0, 8),
            err: err instanceof Error ? err.message : String(err),
          },
          `[${label}] target closed mid-run (attempt ${attempt}/${totalAttempts}); reacquiring`,
        );
        continue;
      }
      // Exhausted. Fall through to the wrap-and-throw below.
    }
  }

  const lastMsg = lastTargetClosedErr instanceof Error
    ? lastTargetClosedErr.message
    : String(lastTargetClosedErr);
  const wrapped = new Error(
    `[tab-recovery] gave up after ${totalAttempts} attempts: ${lastMsg}`,
  );
  // Preserve the original error for operators inspecting the cause.
  (wrapped as Error & { cause?: unknown }).cause = lastTargetClosedErr;
  throw wrapped;
}
