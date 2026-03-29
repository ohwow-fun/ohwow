/**
 * Simulator (E24) — What-If Engine
 *
 * Takes a causal model snapshot and simulates the effects of
 * proposed interventions.
 */

import { propagateIntervention } from './causal-model.js';
import type { CausalModelSnapshot, Intervention, SimulationResult } from './types.js';

/**
 * Simulate a what-if intervention on the causal model.
 */
export function whatIf(snapshot: CausalModelSnapshot, intervention: Intervention): SimulationResult {
  const sourceNode = snapshot.nodes.find((n) => n.id === intervention.nodeId);
  if (!sourceNode) {
    return { intervention, projections: [], overallConfidence: 0 };
  }
  let changeAmount: number;
  if (intervention.changeType === 'percentage') {
    changeAmount = sourceNode.currentValue * (intervention.changeValue / 100);
  } else {
    changeAmount = intervention.changeValue;
  }
  const effects = propagateIntervention(snapshot.nodes, snapshot.edges, intervention.nodeId, changeAmount);
  const projections: SimulationResult['projections'] = [];
  projections.push({
    nodeId: sourceNode.id, nodeName: sourceNode.name, currentValue: sourceNode.currentValue,
    projectedValue: sourceNode.currentValue + changeAmount,
    changePercent: sourceNode.currentValue !== 0 ? (changeAmount / sourceNode.currentValue) * 100 : 0,
    confidence: 1,
  });
  for (const [nodeId, effect] of effects) {
    const node = snapshot.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    projections.push({
      nodeId, nodeName: node.name, currentValue: node.currentValue,
      projectedValue: effect.projectedValue, changePercent: effect.changePercent, confidence: effect.confidence,
    });
  }
  const overallConfidence = projections.length > 0
    ? projections.reduce((sum, p) => sum + p.confidence, 0) / projections.length : 0;
  return { intervention, projections, overallConfidence };
}

/**
 * Run multiple what-if scenarios and return all results.
 */
export function runScenarios(snapshot: CausalModelSnapshot, interventions: Intervention[]): SimulationResult[] {
  return interventions.map((intervention) => whatIf(snapshot, intervention));
}
