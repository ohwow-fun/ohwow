import type { Experiment, ExperimentCategory, ExperimentContext, Finding, ProbeResult, Verdict } from '../experiment-types.js';
export class UnforgettableGeneralizationSignalProbeExperiment implements Experiment {
  readonly id = 'unforgettable-generalization-signal-probe';
  readonly name = 'Unforgettable Generalization Signal Detection';
  readonly category: ExperimentCategory = 'model_health';
  readonly hypothesis = 'Models fine-tuned to forget specific skills may exhibit measurable shifts in generalization behavior, detectable via changes in prediction entropy or task performance on held-out data.';
  readonly cadence = { everyMs: 7200000, runOnBoot: false };
  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    try {
      const { data, error } = await ctx.db.from<{ id: string; tags: string[]; prediction_entropy: number; generalization_gap: number; forgetting_persistence: number }>('model_performance_metrics').select('id,tags,prediction_entropy,generalization_gap,forgetting_persistence').eq('tags', 'unlearn').or('tags,eq,forget').limit(100);
      if (error) {
        return { subject: null, summary: 'database query failed', evidence: { error: error.message } };
      }
      const rows = data ?? [];
      const metrics = rows.map((row: { id: string; tags: string[]; prediction_entropy: number; generalization_gap: number; forgetting_persistence: number }) => ({
        id: row.id,
        prediction_entropy: row.prediction_entropy,
        generalization_gap: row.generalization_gap,
        forgetting_persistence: row.forgetting_persistence
      }));
      const avgEntropy = metrics.reduce((sum: number, m: { prediction_entropy: number }) => sum + m.prediction_entropy, 0) / (metrics.length || 1);
      const avgGap = metrics.reduce((sum: number, m: { generalization_gap: number }) => sum + m.generalization_gap, 0) / (metrics.length || 1);
      const avgPersistence = metrics.reduce((sum: number, m: { forgetting_persistence: number }) => sum + m.forgetting_persistence, 0) / (metrics.length || 1);
      return { subject: null, summary: `analyzed ${metrics.length} models`, evidence: { avgEntropy, avgGap, avgPersistence, sampleCount: metrics.length } };
    } catch (err) {
      return { subject: null, summary: 'probe error', evidence: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
  judge(_r: ProbeResult, _h: Finding[]): Verdict {
    const evidence = _r.evidence as { avgEntropy?: number; avgGap?: number; avgPersistence?: number; sampleCount?: number; error?: string };
    if (evidence.error) return 'fail';
    if (!evidence.sampleCount || evidence.sampleCount === 0) return 'warning';
    if (evidence.avgGap && evidence.avgGap > 0.1) return 'warning';
    return 'pass';
  }
}