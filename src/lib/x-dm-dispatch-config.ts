/**
 * x-dm-dispatch-config — tier-2 tunables for the X DM reply dispatcher.
 *
 * Extracted from x-dm-reply-dispatcher.ts so the autonomous loop can
 * heal the send-rate knobs under Layer 9 tier-2 whole-file policy
 * without touching the dispatcher's DB + CDP control flow. Both
 * constants are safety-critical in opposite directions:
 *
 *   - Too-short interval: CDP lane contention with the DM poller +
 *     content-cadence scheduler; sends time out and the X rate-limit
 *     counter climbs without any message landing.
 *   - Too-long interval: operator-approved replies queue up and the
 *     approval → actual-send round-trip exceeds the human-tolerable
 *     window (minutes, not tens of minutes).
 *   - Too-large batch: one bad CDP navigation cascades across many
 *     sends in a single tick; one stuck lane stalls every other
 *     scheduler that wants it.
 *   - Too-small batch: approvals land faster than the tick rate can
 *     drain them; backlog silently grows.
 *
 * Fuzzed by x-dm-dispatch-config-fuzz. Any edit that drifts outside
 * the sane ranges emits a warning finding with affected_files pointing
 * back here; patch-author heals whole-file under the tier-2 gate. The
 * fuzzer's ranges are intentionally looser than the current values
 * (floor well below, ceiling well above) so the loop has genuine room
 * to tune without immediately tripping the alarm.
 */

/**
 * Default dispatcher tick interval (milliseconds). Min floor keeps CDP
 * lane contention bounded; max ceiling prevents a stalled-backlog
 * failure mode where approvals sit for tens of minutes because the
 * dispatcher tick is misconfigured.
 */
export const DM_DISPATCH_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Max sends per dispatcher tick. Each send holds the CDP lane for
 * ~5s and navigates; smaller batches beat single-tick stalls when one
 * send misbehaves.
 */
export const DM_DISPATCH_MAX_PER_TICK = 5;
