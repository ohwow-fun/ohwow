import type { Experiment, ExperimentCategory, ExperimentContext, Finding, ProbeResult, Verdict } from '../experiment-types.js';
export class UnforgettableGeneralizationDriftProbeExperiment implements Experiment {
  readonly id = 'unforgettable-generalization-drift-probe';
  readonly name = 'Unforgettable Generalization Drift Probe';
  readonly category: ExperimentCategory = 'model_health';
  readonly hypothesis = 'Monitoring for generalization drift after unlearning tasks will reveal how model behavior changes, drawing from paper 2409.02228v1.';
  readonly cadence = { everyMs: 86400000, runOnBoot: false };
  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    try {
      const { data: unlearningData, error: unlearningError } = await ctx.db.from<{ id: string; timestamp: string; task: string }>('model_unlearning_logs').select('id,timestamp,task').limit(100);
      if (unlearningError) {
        return { subject: null, summary: 'unlearning logs query error', evidence: { error: unlearningError } };
      }
      const { data: metricsData, error: metricsError } = await ctx.db.from<{ id: string; randomness_score: number; performance_drift: number }>('generalization_metrics').select('id,randomness_score,performance_drift').limit(100);
      if (metricsError) {
        return { subject: null, summary: 'generalization metrics query error', evidence: { error: metricsError } };
      }
      const unlearningCount = (unlearningData ?? []).length;
      const avgRandomness = (metricsData ?? []).reduce((acc: number, m: { randomness_score: number }) => acc + m.randomness_score, 0) / (metricsData ?? []).length || 0;
      const avgDrift = (metricsData ?? []).reduce((acc: number, m: { performance_drift: number }) => acc + m.performance_drift, 0) / (metricsData ?? []).length || 0;
      return { subject: null, summary: `unlearning logs: ${unlearningCount}, avg randomness: ${avgRandomness.toFixed(3)}, avg drift: ${avgDrift.toFixed(3)}`, evidence: { unlearningCount, avgRandomness, avgDrift } };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { subject: null, summary: 'probe error', evidence: { error: errorMessage } };
    }
  }
  judge(_r: ProbeResult, _h: Finding[]): Verdict {
    const evidence = _r.evidence as { unlearningCount?: number; avgRandomness?: number; avgDrift?: number; error?: string };
    if (evidence.error) {
      return 'fail';
    }
    if (evidence.unlearningCount === undefined || evidence.avgRandomness === undefined || evidence.avgDrift === undefined) {
      return 'warning';
    }
    if (evidence.avgDrift > 0.1 || evidence.avgRandomness > 0.5) {
      return 'warning';
    }
    return 'pass';
  }
}