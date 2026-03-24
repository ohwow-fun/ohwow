/**
 * Loop Detector
 *
 * Detects automation loops by tracking fire rate per source:chatId
 * within a sliding window. Used by LocalTriggerEvaluator to trip
 * a circuit breaker when triggers fire too rapidly.
 */

const LOOP_WINDOW_MS = 10_000; // 10-second sliding window
const LOOP_MAX_FIRES = 5;      // max fires per source:chatId in window

export class LoopDetector {
  /** Tracks trigger invocation timestamps per source:chatId. */
  private triggerInvocations = new Map<string, number[]>();

  /**
   * Returns true if the circuit breaker should trip for the given
   * source:chatId combination (too many fires in the sliding window).
   */
  isLooping(source: string, chatId: string): boolean {
    const key = `${source}:${chatId}`;
    const now = Date.now();
    let timestamps = this.triggerInvocations.get(key);

    if (!timestamps) {
      timestamps = [];
      this.triggerInvocations.set(key, timestamps);
    }

    // Prune timestamps outside the sliding window
    const cutoff = now - LOOP_WINDOW_MS;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= LOOP_MAX_FIRES) {
      return true;
    }

    timestamps.push(now);
    return false;
  }
}
