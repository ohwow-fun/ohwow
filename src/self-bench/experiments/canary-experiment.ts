/**
 * CanaryExperiment — runs the deterministic tool canary suite every
 * 15 minutes and lands one finding per tick summarizing which
 * canaries passed.
 *
 * This is Phase 2's first new probe beyond the E1/E2 wrappers. It
 * produces signal the system couldn't generate before: a continuous
 * "is the tool substrate still working?" heartbeat independent of
 * real task traffic. A canary failure means the executors themselves
 * regressed — not the model, not the agent config, not the router.
 * That's a narrower diagnostic than any existing check.
 *
 * No intervene — the substrate can't fix itself. A failing canary is
 * a signal for the operator (or a future Phase 3 experiment) to
 * investigate. The finding's evidence captures every canary's
 * outcome so the operator can see exactly which one failed without
 * re-running the suite.
 */

import type {
  Experiment,
  ExperimentContext,
  Finding,
  ProbeResult,
  Verdict,
} from '../experiment-types.js';
import { CANARY_SUITE, type CanaryOutcome } from './canaries.js';

interface CanaryEvidence extends Record<string, unknown> {
  outcomes: CanaryOutcome[];
  passed: number;
  failed: number;
  total: number;
  total_latency_ms: number;
}

export class CanaryExperiment implements Experiment {
  id = 'tool-canary-suite';
  name = 'Direct-dispatch tool canary suite';
  category = 'canary' as const;
  hypothesis =
    'The core tool substrate (bash executor, filesystem executor, FileAccessGuard) round-trips deterministic probes with expected outputs and denies out-of-bounds access.';
  cadence = { everyMs: 15 * 60 * 1000, runOnBoot: true };

  async probe(_ctx: ExperimentContext): Promise<ProbeResult> {
    const outcomes: CanaryOutcome[] = [];
    for (const canary of CANARY_SUITE) {
      outcomes.push(await canary());
    }

    const passed = outcomes.filter((o) => o.passed).length;
    const failed = outcomes.length - passed;
    const totalLatency = outcomes.reduce((sum, o) => sum + o.latencyMs, 0);

    const evidence: CanaryEvidence = {
      outcomes,
      passed,
      failed,
      total: outcomes.length,
      total_latency_ms: totalLatency,
    };

    const summary = failed === 0
      ? `${passed}/${outcomes.length} canaries passed (${totalLatency}ms)`
      : `${failed}/${outcomes.length} canaries FAILED: ${outcomes.filter((o) => !o.passed).map((o) => o.id).join(', ')}`;

    const subject = failed === 0
      ? null
      : `canary:${outcomes.find((o) => !o.passed)?.id}`;

    return { subject, summary, evidence };
  }

  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const ev = result.evidence as CanaryEvidence;
    if (ev.failed === 0) return 'pass';
    // One failing canary is a warning — could be a flaky tmpdir,
    // disk pressure, concurrent operator cleanup. Two or more
    // failures indicate a real substrate regression.
    if (ev.failed === 1) return 'warning';
    return 'fail';
  }
}
