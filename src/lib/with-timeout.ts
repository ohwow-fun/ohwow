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

/**
 * Build an AbortController whose signal fires when any of these conditions hit:
 *   1. An external signal (caller's per-iteration timeout) aborts.
 *   2. Our own connect-phase deadline elapses (fallback for callers that
 *      didn't pass a signal, or whose signal is longer than the provider
 *      should allow).
 *   3. A caller explicitly calls `controller.abort()` (e.g. from an idle
 *      watchdog that fired because the stream went silent).
 *
 * Returns the controller plus a `dispose()` that MUST be called in a finally
 * block. Dispose clears the deadline timer and detaches the external-signal
 * listener so we don't leak either.
 *
 * Bug #7: several providers hardcoded `AbortSignal.timeout(120_000)` on fetch
 * and silently dropped `params.signal`, nullifying the bug #6 per-iteration
 * timeout. Others combined signals via `AbortSignal.any` but then read from
 * `response.body` without racing the signal, so a reasoning-only stream
 * (e.g. xiaomi/mimo-v2-pro emitting only `delta.reasoning`) would pin the
 * for-await iterator until the process died. This helper gives every
 * provider a single, correct place to wire the request-level cancellation.
 */
export function linkRequestSignal(
  external: AbortSignal | undefined,
  deadlineMs: number,
): { controller: AbortController; signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => {
    controller.abort(new TimeoutError(`request deadline ${deadlineMs}ms`, deadlineMs));
  }, deadlineMs);

  let externalListener: (() => void) | null = null;
  if (external) {
    if (external.aborted) {
      controller.abort(external.reason ?? new Error('external signal already aborted'));
    } else {
      externalListener = () => {
        controller.abort(external.reason ?? new Error('external signal aborted'));
      };
      external.addEventListener('abort', externalListener, { once: true });
    }
  }

  return {
    controller,
    signal: controller.signal,
    dispose() {
      clearTimeout(deadlineTimer);
      if (externalListener && external) {
        external.removeEventListener('abort', externalListener);
      }
    },
  };
}

/**
 * Build a rejection promise that fires when `signal` aborts. Useful for
 * racing against `reader.read()` inside SSE stream parsers, since Node's
 * fetch AbortSignal propagation to in-flight body reads is not always
 * reliable. Returns the promise plus a `detach()` cleanup to call in a
 * finally block so the listener doesn't leak. The returned promise has a
 * no-op .catch attached so it never surfaces as an unhandled rejection when
 * the read resolves first and the race promise is dropped.
 */
export function abortPromise(signal: AbortSignal): {
  promise: Promise<never>;
  detach: () => void;
} {
  let detach = () => {};
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('signal already aborted'));
      return;
    }
    const onAbort = () => {
      reject(signal.reason ?? new Error('signal aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    detach = () => signal.removeEventListener('abort', onAbort);
  });
  // Prevent unhandled-rejection warnings when the race resolves first.
  promise.catch(() => {});
  return { promise, detach };
}
