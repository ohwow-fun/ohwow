/**
 * Causal Model (E24) — Graph Structure and Linear Regression
 *
 * Computes correlations between time-series business metrics
 * and builds a simple causal graph for what-if projections.
 */

import type { CausalNode, CausalEdge } from './types.js';

// Minimum absolute correlation to create an edge
const MIN_CORRELATION = 0.3;

/**
 * Compute Pearson correlation between two time series.
 * Returns value in [-1, 1].
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i]; sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i]; sumY2 += y[i] * y[i];
  }
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Compute linear regression coefficient (slope).
 */
export function linearCoefficient(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]; sumY += y[i]; sumXY += x[i] * y[i]; sumX2 += x[i] * x[i];
  }
  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

/**
 * Build causal edges from pairwise correlation of all nodes.
 * Tests both immediate and lagged (7-day) correlations.
 */
export function buildCausalEdges(nodes: CausalNode[]): CausalEdge[] {
  const edges: CausalEdge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]; const b = nodes[j];
      const corr0 = pearsonCorrelation(a.historicalValues, b.historicalValues);
      if (Math.abs(corr0) >= MIN_CORRELATION) {
        const coeff = linearCoefficient(a.historicalValues, b.historicalValues);
        edges.push({ fromId: a.id, toId: b.id, correlation: corr0, direction: corr0 > 0 ? 'positive' : 'negative', lagDays: 0, coefficient: coeff });
      }
      if (a.historicalValues.length > 7 && b.historicalValues.length > 7) {
        const aLead = a.historicalValues.slice(0, -7);
        const bLag = b.historicalValues.slice(7);
        const corrLag = pearsonCorrelation(aLead, bLag);
        if (Math.abs(corrLag) > Math.abs(corr0) && Math.abs(corrLag) >= MIN_CORRELATION) {
          const coeff = linearCoefficient(aLead, bLag);
          const immediateIdx = edges.findIndex((e) => e.fromId === a.id && e.toId === b.id && e.lagDays === 0);
          if (immediateIdx >= 0) edges.splice(immediateIdx, 1);
          edges.push({ fromId: a.id, toId: b.id, correlation: corrLag, direction: corrLag > 0 ? 'positive' : 'negative', lagDays: 7, coefficient: coeff });
        }
      }
    }
  }
  return edges;
}

/**
 * Propagate an intervention through the causal graph.
 */
export function propagateIntervention(
  nodes: CausalNode[], edges: CausalEdge[], sourceNodeId: string, changeAmount: number
): Map<string, { projectedValue: number; changePercent: number; confidence: number }> {
  const results = new Map<string, { projectedValue: number; changePercent: number; confidence: number }>();
  const outEdges = edges.filter((e) => e.fromId === sourceNodeId);
  for (const edge of outEdges) {
    const targetNode = nodes.find((n) => n.id === edge.toId);
    if (!targetNode) continue;
    const projectedChange = changeAmount * edge.coefficient;
    const projectedValue = targetNode.currentValue + projectedChange;
    const changePercent = targetNode.currentValue !== 0 ? (projectedChange / targetNode.currentValue) * 100 : 0;
    const confidence = Math.abs(edge.correlation) * (edge.lagDays === 0 ? 1 : 0.8);
    results.set(edge.toId, { projectedValue, changePercent, confidence });
    const secondEdges = edges.filter((e) => e.fromId === edge.toId);
    for (const secondEdge of secondEdges) {
      if (secondEdge.toId === sourceNodeId) continue;
      if (results.has(secondEdge.toId)) continue;
      const secondTarget = nodes.find((n) => n.id === secondEdge.toId);
      if (!secondTarget) continue;
      const secondChange = projectedChange * secondEdge.coefficient;
      const secondProjected = secondTarget.currentValue + secondChange;
      const secondChangePercent = secondTarget.currentValue !== 0 ? (secondChange / secondTarget.currentValue) * 100 : 0;
      const secondConfidence = confidence * Math.abs(secondEdge.correlation) * 0.5;
      if (secondConfidence >= 0.1) {
        results.set(secondEdge.toId, { projectedValue: secondProjected, changePercent: secondChangePercent, confidence: secondConfidence });
      }
    }
  }
  return results;
}
