/**
 * singleflight — coalesce concurrent calls to a lazy initializer.
 *
 * Many places in the codebase initialize a long-lived singleton resource
 * (MCP client manager, browser service, body state service, etc.) on first
 * use with the check-then-set pattern:
 *
 *   if (!this.resource) this.resource = await create();
 *
 * Concurrent callers race past the guard and all run create() in parallel.
 * The last assignment wins; the others' resources are orphaned. Worse, in
 * cases like MCP subprocess spawning, the parallel initializations contend
 * on shared resources (stdio pipes, ports, processes) and at least one
 * caller can hang indefinitely. Bug #6 in the proprioception bench.
 *
 * singleflight() wraps an initializer so all concurrent callers share one
 * in-flight Promise. Subsequent calls after the first init completes return
 * immediately via the `isReady` check (which the caller provides — typically
 * `() => this.resource !== null`). On error, the cached promise is dropped
 * so the next caller can retry.
 *
 * Usage:
 *
 *   private clientsInitPromise: Promise<void> | null = null;
 *
 *   async ensureConnected(): Promise<void> {
 *     if (this.clients) return;
 *     if (!this.clientsInitPromise) {
 *       this.clientsInitPromise = this.doConnect().catch((err) => {
 *         this.clientsInitPromise = null;
 *         throw err;
 *       });
 *     }
 *     await this.clientsInitPromise;
 *   }
 *
 * Or via the helper for a one-liner factory:
 *
 *   private ensureConnected = singleflight(
 *     () => this.clients !== null,
 *     () => this.doConnect(),
 *   );
 */

/**
 * Wrap an async init function so concurrent calls share one in-flight
 * Promise. Returns a callable; each invocation either:
 *
 *   - returns immediately if `isReady()` is true (no work needed)
 *   - awaits the in-flight init promise if one is already running
 *   - starts a new init promise and awaits it
 *
 * On rejection the cached promise is cleared so a retry can run cleanly.
 * The init function receives no arguments — bind any state via closure.
 *
 * Note: this helper deliberately does NOT cache the resolved value. The
 * caller is expected to assign the result inside `doInit` (e.g. to a class
 * field) and check that field via `isReady`. This keeps the helper
 * type-agnostic and avoids subtle issues with cached `undefined` values.
 */
export function singleflight(
  isReady: () => boolean,
  doInit: () => Promise<void>,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return async () => {
    if (isReady()) return;
    if (!inFlight) {
      inFlight = doInit().catch((err) => {
        inFlight = null;
        throw err;
      }).then(() => {
        // Once init resolves successfully, leave inFlight as a settled
        // promise so any callers still in the await queue see "done"
        // immediately. Subsequent fresh calls take the fast `isReady` path.
      });
    }
    await inFlight;
  };
}
