import type { Experiment, ExperimentCategory, ExperimentContext, Finding, ProbeResult, Verdict } from '../experiment-types.js';
export class UnforgettableGeneralizationSignalExperiment implements Experiment {
  readonly id = 'unforgettable-generalization-signal';
  readonly name = 'Unforgettable Generalization Signal Monitor';
  readonly category: ExperimentCategory = 'model_health';
  readonly hypothesis = "Probing for signals of 'unforgettable' generalization (per arXiv:2409.02228v1) will help detect unintended skill retention or degradation in the model.";
  readonly cadence = { everyMs: 86400000, runOnBoot: false };
  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    try {
      const { data: genData, error: genError } = await ctx.db.from<{ task_id: string; prediction_consistency: number }>('model_generalization_metrics').select('task_id,prediction_consistency').limit(10);
      if (genError) {
        return { subject: null, summary: 'database query error', evidence: { error: genError } };
      }
      const consistencyValues = (genData ?? []).map((row: { task_id: string; prediction_consistency: number }) => row.prediction_consistency);
      const avgConsistency = consistencyValues.length > 0 ? consistencyValues.reduce((acc: number, val: number) => acc + val, 0) / consistencyValues.length : 0;
      const { data: unlearnData, error: unlearnError } = await ctx.db.from<{ outcome: string }>('unlearning_outcomes').select('outcome').limit(10);
      if (unlearnError) {
        return { subject: null, summary: 'unlearning outcomes query error', evidence: { error: unlearnError } };
      }
      const unlearnOutcomes = unlearnData ?? [];
      const subject = `avg_consistency_${avgConsistency.toFixed(3)}`;
      const summary = `Checked ${consistencyValues.length} generalization metrics and ${unlearnOutcomes.length} unlearning outcomes`;
      const evidence = { avgConsistency, consistencyCount: consistencyValues.length, unlearningCount: unlearnOutcomes.length };
      return { subject, summary, evidence };
    } catch (err) {
      return { subject: null, summary: 'probe error', evidence: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
  judge(_r: ProbeResult, _h: Finding[]): Verdict {
    const avgConsistency = typeof _r.evidence?.avgConsistency === 'number' ? _r.evidence.avgConsistency : 0;
    if (avgConsistency > 0.8) {
      return 'warning';
    }
    return 'pass';
  }
}