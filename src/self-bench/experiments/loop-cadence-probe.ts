/**
 * LoopCadenceProbeExperiment — self-observes the experiment loop.
 *
 * Reads ran_at from self_findings for every registered peer experiment
 * and computes the median gap between consecutive runs. Compares each
 * peer's observed cadence to its declared cadence.everyMs and emits a
 * warning when the loop appears stalled (no recent runs, or median gap
 * wildly exceeds the declared cadence).
 *
 * This closes the self-observation loop: the user shouldn't have to
 * eyeball sqlite to know cadence drift is happening. Observe-only — no
 * intervene; drift is a signal, not an action.
 */

import type {
  Experiment,
  ExperimentCategory,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';

const HISTORY_LIMIT = 12;
/** Staleness multiple on cadence.everyMs before we flag. */
const STALE_MULTIPLIER = 5;
/** Floor for staleness (never flag as stale if it's been less than this). */
const STALE_FLOOR_MS = 60_000;

export interface PeerCadence {
  experiment_id: string;
  declared_every_ms: number;
  run_count: number;
  median_gap_ms: number | null;
  max_gap_ms: number | null;
  last_ran_at: string | null;
  ms_since_last_run: number | null;
  stale: boolean;
}

export interface LoopCadenceEvidence extends Record<string, unknown> {
  peers: PeerCadence[];
  stale_peers: string[];
  now: string;
}

export class LoopCadenceProbeExperiment implements Experiment {
  readonly id = 'loop-cadence-probe';
  readonly name = 'Experiment loop cadence self-observation';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis =
    'Each registered experiment fires at a cadence close to its declared ' +
    'everyMs. If the observed median gap is many multiples off, the ' +
    'scheduler (heartbeat, inFlight, or clocks) has drifted.';
  readonly cadence = { everyMs: 60_000, runOnBoot: true };

  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    const scheduler = ctx.scheduler;
    if (!scheduler) {
      return {
        subject: 'meta:loop-cadence',
        summary: 'no scheduler in context',
        evidence: { peers: [], stale_peers: [], now: new Date().toISOString() },
      };
    }
    const peers = scheduler.getRegisteredExperimentInfo().filter((p) => p.id !== this.id);
    const now = Date.now();
    const rows: PeerCadence[] = [];
    for (const peer of peers) {
      const history = await ctx.recentFindings(peer.id, HISTORY_LIMIT);
      rows.push(summarizePeer(peer.id, peer.cadence.everyMs, history, now));
    }
    // Witness: most recent ran_at across all peers. If no other peer
    // ran AFTER a candidate-stale peer's due time, the daemon likely
    // just restarted and the long-cadence peer hasn't had a chance to
    // fire yet. That's not stale — that's cold. Suppress the flag.
    const witnessMs = rows.reduce(
      (acc, r) => (r.last_ran_at ? Math.max(acc, Date.parse(r.last_ran_at)) : acc),
      0,
    );
    for (const r of rows) {
      if (!r.stale || !r.last_ran_at) continue;
      const dueAt = Date.parse(r.last_ran_at) + r.declared_every_ms;
      if (witnessMs < dueAt) r.stale = false;
    }
    const stalePeers = rows.filter((r) => r.stale).map((r) => r.experiment_id);
    const evidence: LoopCadenceEvidence = {
      peers: rows,
      stale_peers: stalePeers,
      now: new Date(now).toISOString(),
    };
    const summary = stalePeers.length === 0
      ? `${rows.length} peers on cadence`
      : `${stalePeers.length} stale: ${stalePeers.slice(0, 3).join(', ')}`;
    return { subject: 'meta:loop-cadence', summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as LoopCadenceEvidence;
    return ev.stale_peers.length > 0 ? 'warning' : 'pass';
  }
}

export function summarizePeer(
  experimentId: string,
  declaredEveryMs: number,
  history: Finding[],
  now: number,
): PeerCadence {
  const timestamps = history
    .map((h) => Date.parse(h.ranAt))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (timestamps.length === 0) {
    return {
      experiment_id: experimentId,
      declared_every_ms: declaredEveryMs,
      run_count: 0,
      median_gap_ms: null,
      max_gap_ms: null,
      last_ran_at: null,
      ms_since_last_run: null,
      stale: false,
    };
  }
  const last = timestamps[timestamps.length - 1];
  const msSince = now - last;
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i - 1]);
  const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
  const max = gaps.length ? Math.max(...gaps) : null;
  const staleThreshold = Math.max(STALE_FLOOR_MS, declaredEveryMs * STALE_MULTIPLIER);
  const stale = msSince > staleThreshold;
  return {
    experiment_id: experimentId,
    declared_every_ms: declaredEveryMs,
    run_count: timestamps.length,
    median_gap_ms: median,
    max_gap_ms: max,
    last_ran_at: new Date(last).toISOString(),
    ms_since_last_run: msSince,
    stale,
  };
}
