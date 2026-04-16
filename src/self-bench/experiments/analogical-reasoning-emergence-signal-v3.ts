import type { Experiment, ExperimentCategory, ExperimentContext, Finding, ProbeResult, Verdict } from '../experiment-types.js';
export class AnalogicalReasoningEmergenceSignalV3Experiment implements Experiment {
  readonly id = 'analogical-reasoning-emergence-signal-v3';
  readonly name = 'Analogical Reasoning Emergence Signal v3';
  readonly category: ExperimentCategory = 'model_health';
  readonly hypothesis = 'Probing for emergent analogical reasoning signals in model outputs will detect zero-shot analogy problem-solving capabilities, as discussed in paper 2308.16118v2.';
  readonly cadence = { everyMs: 7200000, runOnBoot: false };
  async probe(ctx: ExperimentContext): Promise<ProbeResult> {
    try {
      const { data: analogyData, error: analogyError } = await ctx.db.from<{ id: string; solution_type: string; correct: boolean }>('model_output_analogies').select('id,solution_type,correct').eq('created_at', 'recent').limit(100);
      if (analogyError) {
        return { subject: null, summary: 'database error on analogies', evidence: { error: analogyError } };
      }
      const analogies = analogyData ?? [];
      const zeroShotCount = analogies.filter((a: { solution_type: string }) => a.solution_type === 'zero_shot').length;
      const correctCount = analogies.filter((a: { correct: boolean }) => a.correct).length;
      const correctnessRate = analogies.length > 0 ? correctCount / analogies.length : 0;
      const { data: graphData, error: graphError } = await ctx.db.from<{ id: string; relation: string }>('knowledge_graph_embeddings').select('id,relation').eq('relation', 'analogy').limit(50);
      if (graphError) {
        return { subject: null, summary: 'database error on graph', evidence: { error: graphError } };
      }
      const graphConnections = graphData ?? [];
      return { subject: null, summary: `zero-shot analogies: ${zeroShotCount}, correctness: ${(correctnessRate * 100).toFixed(1)}%, graph connections: ${graphConnections.length}`, evidence: { zeroShotCount, correctnessRate, graphConnectionCount: graphConnections.length } };
    } catch (err) {
      return { subject: null, summary: 'probe error', evidence: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
  judge(_r: ProbeResult, _h: Finding[]): Verdict {
    const evidence = _r.evidence as { zeroShotCount?: number; correctnessRate?: number; graphConnectionCount?: number };
    const zeroShotCount = evidence.zeroShotCount ?? 0;
    const correctnessRate = evidence.correctnessRate ?? 0;
    const graphConnectionCount = evidence.graphConnectionCount ?? 0;
    if (zeroShotCount > 0 && correctnessRate > 0.5 && graphConnectionCount > 0) {
      return 'pass';
    }
    if (zeroShotCount > 0 || correctnessRate > 0.3 || graphConnectionCount > 0) {
      return 'warning';
    }
    return 'fail';
  }
}