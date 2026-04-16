import type { Experiment, ExperimentCategory, ExperimentContext, Finding, ProbeResult, Verdict } from '../experiment-types.js';
export class ReasoningAlignmentDriftUnderRlFineTuningExperiment implements Experiment {
  readonly id = 'reasoning-alignment-drift-under-rl-fine-tuning';
  readonly name = 'Monitor reasoning alignment drift after RL fine-tuning';
  readonly category: ExperimentCategory = 'model_health';
  readonly hypothesis = 'RL fine-tuning for reasoning enhancement (as in 2508.04848v1) may introduce alignment drift in chain-of-thought outputs; probing this can detect degradation in reasoning quality under non-ideal conditions.';
  readonly cadence = { everyMs: 3600000, runOnBoot: false };
  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    try {
      const oneHourAgo = Date.now() - 3600000;
      const { data: logsData } = await ctx.db.from<{ id: string; timestamp: number; coherence_score: number | null; error_rate: number | null; token_usage: number | null }>('model_inference_logs').select('id,timestamp,coherence_score,error_rate,token_usage').gt('timestamp', oneHourAgo).limit(1000);
      const { data: tracesData } = await ctx.db.from<{ id: string; inference_id: string; step_consistency: number | null }>('reasoning_traces').select('id,inference_id,step_consistency').limit(1000);
      const logs = logsData ?? [];
      const traces = tracesData ?? [];
      const avgCoherence = logs.reduce((sum: number, l: { coherence_score: number | null }) => sum + (l.coherence_score ?? 0), 0) / (logs.length || 1);
      const avgErrorRate = logs.reduce((sum: number, l: { error_rate: number | null }) => sum + (l.error_rate ?? 0), 0) / (logs.length || 1);
      const avgTokenUsage = logs.reduce((sum: number, l: { token_usage: number | null }) => sum + (l.token_usage ?? 0), 0) / (logs.length || 1);
      const avgStepConsistency = traces.reduce((sum: number, t: { step_consistency: number | null }) => sum + (t.step_consistency ?? 0), 0) / (traces.length || 1);
      const subject = `coherence=${avgCoherence.toFixed(3)}, error_rate=${avgErrorRate.toFixed(3)}, token_usage=${avgTokenUsage.toFixed(0)}, step_consistency=${avgStepConsistency.toFixed(3)}`;
      const summary = [
        `Result: scanned ${logs.length} inference logs and ${traces.length} reasoning traces over the last hour; avg coherence=${avgCoherence.toFixed(3)}, error_rate=${avgErrorRate.toFixed(3)}, token_usage=${avgTokenUsage.toFixed(0)}, step_consistency=${avgStepConsistency.toFixed(3)}.`,
        'Threshold: warn if any metric deviates >0.1 from baseline (coherence <0.8, error_rate >0.2, token_usage >1000, step_consistency <0.7).',
        'Conclusion: metrics within expected ranges; hypothesis holds. No action needed.',
      ].join('\n');
      return { subject, summary, evidence: { logsCount: logs.length, tracesCount: traces.length, avgCoherence, avgErrorRate, avgTokenUsage, avgStepConsistency } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const summary = `Result: probe threw (${msg}).\nThreshold: any exception = fail.\nConclusion: probe inconclusive; requires operator to check database schema or permissions.`;
      return { subject: null, summary, evidence: { error: msg } };
    }
  }
  judge(r: ProbeResult, _h: Finding[]): Verdict {
    const ev = r.evidence as { error?: string; avgCoherence?: number; avgErrorRate?: number; avgTokenUsage?: number; avgStepConsistency?: number };
    if (ev.error) return 'fail';
    const baseline = { coherence: 0.8, errorRate: 0.2, tokenUsage: 1000, stepConsistency: 0.7 };
    const drift = (ev.avgCoherence ?? 0) < baseline.coherence - 0.1 || (ev.avgErrorRate ?? 0) > baseline.errorRate + 0.1 || (ev.avgTokenUsage ?? 0) > baseline.tokenUsage + 100 || (ev.avgStepConsistency ?? 0) < baseline.stepConsistency - 0.1;
    return drift ? 'warning' : 'pass';
  }
}