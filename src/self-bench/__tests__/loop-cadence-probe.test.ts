import { describe, it, expect } from 'vitest';
import { summarizePeer } from '../experiments/loop-cadence-probe.js';
import type { Finding } from '../experiment-types.js';

function finding(id: string, ranAtMs: number): Finding {
  return {
    id: `${id}-${ranAtMs}`,
    experimentId: id,
    category: 'other',
    subject: null,
    hypothesis: null,
    verdict: 'pass',
    summary: '',
    evidence: {},
    interventionApplied: null,
    ranAt: new Date(ranAtMs).toISOString(),
    durationMs: 0,
    status: 'active',
    supersededBy: null,
    createdAt: new Date(ranAtMs).toISOString(),
  };
}

describe('summarizePeer', () => {
  it('returns null gaps when there is no history', () => {
    const now = 1_000_000;
    const s = summarizePeer('e', 60_000, [], now);
    expect(s.run_count).toBe(0);
    expect(s.median_gap_ms).toBeNull();
    expect(s.stale).toBe(false);
  });

  it('computes median and max gap from multiple runs', () => {
    const now = 1_100_000;
    const runs = [finding('e', 1_000_000), finding('e', 1_010_000), finding('e', 1_050_000)];
    const s = summarizePeer('e', 60_000, runs, now);
    expect(s.run_count).toBe(3);
    // gaps: [10_000, 40_000] → median = 40_000 (upper middle), max = 40_000
    expect(s.max_gap_ms).toBe(40_000);
    expect(s.median_gap_ms).toBe(40_000);
  });

  it('flags stale when last run is older than everyMs * STALE_MULTIPLIER', () => {
    const now = 10 * 60_000;
    // declared every 60s, last run 6min ago (6x cadence > 5x threshold)
    const runs = [finding('e', now - 6 * 60_000)];
    const s = summarizePeer('e', 60_000, runs, now);
    expect(s.stale).toBe(true);
  });

  it('does not flag stale for short cadences within the floor window', () => {
    const now = 10 * 60_000;
    // declared 5s, last ran 30s ago — 6x cadence, but still under the 60s floor
    const runs = [finding('e', now - 30_000)];
    const s = summarizePeer('e', 5_000, runs, now);
    expect(s.stale).toBe(false);
  });

  it('sorts timestamps so out-of-order history still yields sensible gaps', () => {
    const now = 1_100_000;
    const runs = [finding('e', 1_050_000), finding('e', 1_000_000), finding('e', 1_010_000)];
    const s = summarizePeer('e', 60_000, runs, now);
    expect(s.last_ran_at).toBe(new Date(1_050_000).toISOString());
  });
});
