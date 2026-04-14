/**
 * withTimeout — race a promise against a deadline with proper AbortSignal
 * propagation so the upstream call actually gets cancelled, not just orphaned.
 *
 * Used by the orchestrator chat loops to bound every model API call. Without
 * this, a hanging upstream LLM API freezes the entire chat turn forever:
 * the for-await iterator never resolves, the conversation row stays
 * status='running', and only a daemon restart recovers. Bug #6.
 *
 * Usage:
 *   const response = await withTimeout(
 *     'model call (claude-sonnet-4.6, iter 0)',
 *     300_000,
 *     (signal) => provider.createMessage({ ...params, signal }),
 *   );
 *
 * On timeout, throws TimeoutError and aborts the underlying signal. Provider
 * implementations must accept and forward the signal to their fetch / SDK
 * call so the cancellation actually frees server-side resources.
 */

export class TimeoutError extends Error {
  readonly elapsedMs: number;
  readonly label: string;

  constructor(label: string, elapsedMs: number) {
    super(`${label} timed out after ${elapsedMs}ms`);
    this.name = 'TimeoutError';
    this.label = label;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Race `fn` against a `timeoutMs` deadline. The function receives an
 * AbortSignal; if it forwards that signal to its underlying I/O, the
 * upstream request is cancelled when the timeout fires.
 *
 * If `fn` resolves before the deadline, its value is returned and the
 * timer is cleared.
 *
 * If `fn` throws before the deadline, the error propagates and the
 * timer is cleared.
 *
 * If the deadline fires first, the controller is aborted and a
 * TimeoutError is thrown with the elapsed time.
 */
export async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new TimeoutError(label, Date.now() - startedAt));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      // Wrap fn() so any rejection caused by abort is converted to a
      // TimeoutError, not whatever the function's abort handler threw.
      // This makes the surfaced error deterministic when both sides race.
      fn(controller.signal).catch((err) => {
        if (timedOut) {
          throw new TimeoutError(label, Date.now() - startedAt);
        }
        throw err;
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Streaming sibling of withTimeout(). Returns an AbortSignal that fires
 * after `timeoutMs` plus a `cancel()` you must call on success / error to
 * clear the underlying timer. Use this for async-generator model calls
 * where withTimeout()'s promise-race shape doesn't fit. The signal carries
 * a TimeoutError as its abort reason so downstream `.catch` handlers can
 * distinguish a timeout from a normal abort.
 *
 * Pattern:
 *   const { signal, cancel } = createTimeoutController('label', 300_000);
 *   try {
 *     const stream = provider.createSomethingStreaming({ signal, ...rest });
 *     for await (const chunk of stream) { ... }
 *   } catch (err) {
 *     // err may be TimeoutError (re-thrown via signal abort) or a normal stream error
 *     throw err;
 *   } finally {
 *     cancel();
 *   }
 */
export function createTimeoutController(
  label: string,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    controller.abort(new TimeoutError(label, Date.now() - startedAt));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}
