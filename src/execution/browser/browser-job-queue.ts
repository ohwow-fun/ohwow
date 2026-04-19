/**
 * Per-workspace browser job queue — serialize browser-enabled task
 * execution within a single workspace.
 *
 * Why this exists
 * ---------------
 * Two tasks in the same workspace can race on the same browser profile
 * or CDP surface: both launch, both grab a window, and the user ends up
 * with duplicate browser sessions for the same workspace. The profile-
 * mutex (profile-mutex.ts) serializes within a profile directory; this
 * module serializes at the workspace level — one browser task at a time
 * per workspace.
 *
 * Concurrent calls for DIFFERENT workspaces still run in parallel — the
 * queue is keyed by workspaceName. Calls for the SAME workspace run in
 * the order they were requested.
 *
 * Design mirrors profile-mutex.ts exactly:
 *   - Map<workspaceName, Promise<void>> chain. Each withBrowserJob
 *     appends a "release" promise to the tail, then replaces the tail
 *     so the next caller appends behind us.
 *   - A timeoutMs deadline rejects the waiter when exceeded. The held
 *     fn is still allowed to run to completion — the lock only releases
 *     once fn actually settles. That way a timeout does NOT leak the
 *     lock: later waiters just have to wait for the in-flight work to
 *     finish naturally rather than deadlocking.
 *   - The chain never rejects; a crash in one fn still resolves the
 *     release so the next waiter proceeds.
 *
 * Process-scoped. A daemon restart clears the map — by design.
 */

/** Default deadline for waiting to enter the queue. 90s gives a full browser task generous lead time. */
const DEFAULT_TIMEOUT_MS = 90_000;

// Module-level state. Keyed by workspaceName. The stored promise is the
// tail of the chain — it resolves when the current holder's fn settles.
const chains = new Map<string, Promise<void>>();

// Diagnostic only: how many callers are currently holding or waiting.
const depths = new Map<string, number>();

function incDepth(workspaceName: string): void {
  depths.set(workspaceName, (depths.get(workspaceName) ?? 0) + 1);
}

function decDepth(workspaceName: string): void {
  const d = (depths.get(workspaceName) ?? 1) - 1;
  if (d <= 0) depths.delete(workspaceName);
  else depths.set(workspaceName, d);
}

/**
 * Serialize browser-enabled work within a single workspace.
 * Concurrent calls for different workspaces run in parallel.
 * Calls for the same workspace run in the order they were requested.
 *
 * `opts.timeoutMs` defaults to 90_000. On timeout the waiter rejects,
 * but the held fn is still allowed to settle so later waiters don't
 * deadlock on a leaked lock.
 */
export async function withBrowserJob<T>(
  workspaceName: string,
  fn: () => Promise<T>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prev = chains.get(workspaceName) ?? Promise.resolve();

  incDepth(workspaceName);

  // Build the new tail BEFORE awaiting prev, so the next caller sees us
  // in the chain immediately. The tail resolves when our fn settles
  // (after we run). We .catch(() => undefined) the whole sequence so
  // no rejection ever propagates into the chain — a crashed waiter
  // never poisons the queue.
  let releaseSignal!: () => void;
  const release = new Promise<void>((r) => { releaseSignal = r; });
  const newTail = prev.then(() => release);
  chains.set(workspaceName, newTail);

  try {
    await prev; // Wait our turn.

    // Race fn against the timeout. Both are tracked independently:
    //  - If fn settles first, we clear the timer, release the lock,
    //    and return/throw as normal.
    //  - If timeout fires first, we reject the waiter with the timeout
    //    error but keep the lock HELD until fn naturally settles.
    //    That's what lockReleaseAfterFn guarantees: releaseSignal is
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
          () => reject(new Error(`BrowserJobQueue timeout after ${timeoutMs}ms for workspace='${workspaceName}'`)),
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
    decDepth(workspaceName);
    // If we're the tail when the release lands, clear the map entry to
    // avoid keeping a reference to the settled promise chain. Use a
    // microtask so the chain's .then(() => release) has already
    // resolved by the time we check.
    queueMicrotask(() => {
      if (chains.get(workspaceName) === newTail) {
        chains.delete(workspaceName);
      }
    });
  }
}

/** Diagnostics: number of callers currently holding or waiting on the queue. */
export function queueDepthForWorkspace(workspaceName: string): number {
  return depths.get(workspaceName) ?? 0;
}
