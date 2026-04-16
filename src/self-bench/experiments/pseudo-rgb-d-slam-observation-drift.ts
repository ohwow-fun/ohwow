import type { Experiment, ExperimentCategory, ExperimentContext, Finding, ProbeResult, Verdict } from '../experiment-types.js';
export class PseudoRgbDSlamObservationDriftExperiment implements Experiment {
  readonly id = 'pseudo-rgb-d-slam-observation-drift';
  readonly name = 'Pseudo RGB-D SLAM Observation Drift';
  readonly category: ExperimentCategory = 'other';
  readonly hypothesis = 'Pseudo RGB-D self-improving SLAM (2004.10681v3) may introduce drift in mobile agent visual perception freshness, observable via read-only checks of perception logs.';
  readonly cadence = { everyMs: 86400000, runOnBoot: false };
  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    try {
      const { data, error } = await ctx.db.from<{ timestamp: string; depth_consistency_score: number }>('mobile_agent_visual_perception_freshness_drift').select('timestamp,depth_consistency_score').order('timestamp', { ascending: false }).limit(10);
      if (error) {
        return { subject: null, summary: 'database query error', evidence: { error: error.message || String(error) } };
      }
      const rows = data ?? [];
      const scores = rows.map((row: { timestamp: string; depth_consistency_score: number }) => row.depth_consistency_score);
      const avgScore = scores.length > 0 ? scores.reduce((sum: number, s: number) => sum + s, 0) / scores.length : 0;
      const anomalyCount = scores.filter((s: number) => s < 0.7).length;
      return { subject: null, summary: `avg depth consistency ${avgScore.toFixed(2)}, anomalies ${anomalyCount}`, evidence: { avgScore, anomalyCount, sampleCount: rows.length } };
    } catch (err) {
      return { subject: null, summary: 'probe error', evidence: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
  judge(_r: ProbeResult, _h: Finding[]): Verdict {
    const evidence = _r.evidence as { avgScore?: number; anomalyCount?: number };
    if (evidence.anomalyCount && evidence.anomalyCount > 0) {
      return 'warning';
    }
    return 'pass';
  }
}