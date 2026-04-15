/**
 * Outbound-action gate for _approvals.propose(). Enforces a forecast-
 * accuracy floor on outbound replies + DMs: a bucket's rolling 30-day
 * forecast accuracy must be ≥ 0.55 before we let the approval queue
 * auto-apply a write touching that bucket.
 *
 * Fail-closed: no accuracy data → gate returns false (entry stays
 * pending). We never silently auto-apply outbound on a cold queue.
 */
import { loadRollingAccuracy } from './_accuracy.mjs';

const DEFAULT_FLOOR = 0.55;

export function buildOutboundGate(workspace, { floor = DEFAULT_FLOOR, daysBack = 30 } = {}) {
  const acc = loadRollingAccuracy(workspace, daysBack);
  return (_kind, payload) => {
    const bucket = payload?.bucket;
    if (!bucket) return false;
    const row = acc[bucket];
    if (!row || typeof row.acc !== 'number') return false;
    return row.acc >= floor;
  };
}
