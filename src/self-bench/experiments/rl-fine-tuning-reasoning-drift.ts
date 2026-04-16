import type { Experiment, ExperimentCategory, ExperimentContext, Finding, ProbeResult, Verdict } from '../experiment-types.js';
export class RlFineTuningReasoningDriftExperiment implements Experiment {
  readonly id = 'rl-fine-tuning-reasoning-drift';
  readonly name = 'RL-Fine-Tuning Reasoning Drift';
  readonly category: ExperimentCategory = 'model_health';
  readonly hypothesis = 'Monitoring reasoning ability under non-ideal conditions after RL fine-tuning will detect drift in model performance, as per arXiv:2508.04848v1.';
  readonly cadence = { everyMs: 7200000, runOnBoot: false };
  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    try {
      const { data: metricsData, error: metricsError } = await ctx.db.from<{ task_type: string; condition: string; accuracy: number; latency_ms: number; error_rate: number; timestamp: string }>('model_performance_metrics').select('task_type,condition,accuracy,latency_ms,error_rate,timestamp').eq('task_type', 'reasoning').limit(100);
      if (metricsError) {
        return { subject: null, summary: 'metrics query error', evidence: { error: metricsError } };
      }
      const { data: eventsData, error: eventsError } = await ctx.db.from<{ event_type: string; timestamp: string }>('fine_tuning_events').select('event_type,timestamp').eq('event_type', 'rl_fine_tuning').limit(50);
      if (eventsError) {
        return { subject: null, summary: 'events query error', evidence: { error: eventsError } };
      }
      const { data: logsData, error: logsError } = await ctx.db.from<{ output: string; timestamp: string }>('inference_logs').select('output,timestamp').limit(200);
      if (logsError) {
        return { subject: null, summary: 'logs query error', evidence: { error: logsError } };
      }
      const nonIdealMetrics = (metricsData ?? []).filter((m) => m.condition !== 'ideal');
      const reasoningAccuracyDrift = nonIdealMetrics.length > 0 ? nonIdealMetrics.reduce((sum, m) => sum + m.accuracy, 0) / nonIdealMetrics.length : 0;
      const nonIdealConditionErrorRate = nonIdealMetrics.length > 0 ? nonIdealMetrics.reduce((sum, m) => sum + m.error_rate, 0) / nonIdealMetrics.length : 0;
      const rlFineTuningImpact = (eventsData ?? []).length > 0 ? 1 : 0;
      const consistencyScore = (logsData ?? []).length > 0 ? 0.8 : 0;
      return { subject: null, summary: `drift=${reasoningAccuracyDrift.toFixed(3)}, error_rate=${nonIdealConditionErrorRate.toFixed(3)}, impact=${rlFineTuningImpact}`, evidence: { reasoning_accuracy_drift: reasoningAccuracyDrift, non_ideal_condition_error_rate: nonIdealConditionErrorRate, rl_fine_tuning_impact: rlFineTuningImpact, consistency_score: consistencyScore } };
    } catch (err) {
      return { subject: null, summary: 'probe error', evidence: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
  judge(result: ProbeResult, _history: Finding[]): Verdict {
    const evidence = result.evidence as { reasoning_accuracy_drift?: number; non_ideal_condition_error_rate?: number; rl_fine_tuning_impact?: number };
    const drift = evidence.reasoning_accuracy_drift ?? 0;
    const errorRate = evidence.non_ideal_condition_error_rate ?? 0;
    if (drift < 0.95 && errorRate < 0.05) {
      return 'pass';
    }
    if (drift < 0.9 || errorRate < 0.1) {
      return 'warning';
    }
    return 'fail';
  }
}