/**
 * Per-profile mutex — serialize work that touches a specific Chrome
 * profile's CDP surface.
 *
 * Why this exists
 * ---------------
 * Two task-agents can race on the same Chrome profile: both resolve the
 * profile, both call `findExistingTabForHost`, both see "no match", both
 * `openProfileWindow`, and the user ends up with two windows/tabs for
 * the same profile — the exact "new window every fire" symptom the
 * browser-claims registry can't prevent on its own (claims are atomic
 * but they only serialize AT the claim call, not across the whole
 * lookup + open sequence).
 *
 * Concurrent calls for DIFFERENT profiles still run in parallel — the
 * mutex is keyed by profileDir so a Default-profile task doesn't queue
 * behind a Profile 1 task. Calls for the SAME profile run in the order
 * they were requested.
 *
 * Design:
 *   - Map<profileDir, Promise<unknown>> chain. Each `withProfileLock`
 *     appends a "release" promise to the tail, then replaces the tail
 *     so the next caller appends behind us.
 *   - A `timeoutMs` deadline rejects the waiter when exceeded. The
 *     held fn is still allowed to run to completion — the lock only
 *     releases once the fn actually settles. That way a timeout does
 *     NOT leak the lock: later waiters just have to wait for the
 *     in-flight work to finish naturally rather than deadlocking.
 *   - The chain never rejects; a crash in one waiter's fn still
 *     resolves the release so the next waiter proceeds.
 *
 * Process-scoped. A daemon restart clears the map — by design; restart
 * implies no in-flight work on any profile.
 */

/** Default deadline for holding the lock. 60s is generous for a tab lookup + open + navigate; tighter than a full posting run. */
const DEFAULT_TIMEOUT_MS = 60_000;

// Module-level state. Keyed by profileDir. The stored promise is the
// tail of the chain — it resolves when the current holder's fn settles
// (either resolves OR rejects; we never let the chain itself reject).
const chains = new Map<string, Promise<void>>();

// Diagnostic only: how many callers are currently holding or waiting
// on the lock for each profile.
const depths = new Map<string, number>();

function incDepth(profileDir: string): void {
  depths.set(profileDir, (depths.get(profileDir) ?? 0) + 1);
}

function decDepth(profileDir: string): void {
  const d = (depths.get(profileDir) ?? 1) - 1;
  if (d <= 0) depths.delete(profileDir);
  else depths.set(profileDir, d);
}

/**
 * Serialize work that touches a specific profile's CDP surface.
 * Concurrent calls for different profiles run in parallel.
 * Calls for the same profile run in the order they were requested.
 *
 * `opts.timeoutMs` defaults to 60_000. On timeout the waiter rejects,
 * but the held fn is still allowed to settle so later waiters don't
 * deadlock on a leaked lock.
 */
export async function withProfileLock<T>(
  profileDir: string,
  fn: () => Promise<T>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prev = chains.get(profileDir) ?? Promise.resolve();

  incDepth(profileDir);

  // Build the new tail BEFORE awaiting prev, so the next caller sees us
  // in the chain immediately. The tail resolves when our fn settles
  // (after we run). We .catch(() => undefined) the whole sequence so
  // no rejection ever propagates into the chain — a crashed waiter
  // never poisons the queue.
  let releaseSignal!: () => void;
  const release = new Promise<void>((r) => { releaseSignal = r; });
  const newTail = prev.then(() => release);
  chains.set(profileDir, newTail);

  try {
    await prev; // Wait our turn.

    // Race fn against the timeout. Both are tracked independently:
    //  - If fn settles first, we clear the timer, release the lock,
    //    and return/throw as normal.
    //  - If timeout fires first, we reject the waiter with the timeout
    //    error but keep the lock HELD until fn naturally settles.
    //    That's what `lockReleaseAfterFn` guarantees: releaseSignal is
    //    only called after fn resolves/rejects, regardless of whether
    //    the race completed early.
    let timer: NodeJS.Timeout | undefined;
    const fnPromise = fn();

    // Decouple the lock release from the race outcome. The release
    // waits for the fn itself, not for the Promise.race wrapper.
    const lockReleaseAfterFn = fnPromise.then(
      () => { /* noop */ },
      () => { /* swallow — chain never rejects */ },
    ).finally(() => { releaseSignal(); });

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`profile-mutex timed out after ${timeoutMs}ms for profileDir=${profileDir}`)),
          timeoutMs,
        );
      });
      return await Promise.race([fnPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
      // Ensure the chain stays consistent even if the runtime wakes us
      // from the race before the fn settles — lockReleaseAfterFn owns
      // the real release and is already queued.
      void lockReleaseAfterFn;
    }
  } finally {
    decDepth(profileDir);
    // If we're the tail when the release lands, clear the map entry to
    // avoid keeping a reference to the settled promise chain. Use a
    // microtask so the chain's `.then(() => release)` has already
    // resolved by the time we check.
    queueMicrotask(() => {
      if (chains.get(profileDir) === newTail) {
        // Still the tail and we're settled — clean up.
        chains.delete(profileDir);
      }
    });
  }
}

/** Diagnostics: number of callers currently holding or waiting on the lock. */
export function queueDepth(profileDir: string): number {
  return depths.get(profileDir) ?? 0;
}
