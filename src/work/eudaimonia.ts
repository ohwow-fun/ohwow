/**
 * Eudaimonia — Flourishing Score (Aristotle)
 *
 * "Happiness is an activity of the soul in accordance with virtue."
 * — Aristotle, Nicomachean Ethics
 *
 * Not "happiness" but "flourishing" — the state of everything working
 * well together. For a workspace, eudaimonia is: agents are effective,
 * goals are progressing, the team is growing, the business is thriving,
 * and the work is aligned with purpose.
 *
 * This is the north star metric. A single composite score that subsumes
 * all others. When eudaimonia drops, the system diagnoses WHY.
 */

import type { EudaimoniaScore, EudaimoniaInput, EudaimoniaDimension, EudaimoniaStatus } from './types.js';

// ============================================================================
// DIMENSION WEIGHTS
// ============================================================================

const DIMENSIONS: Array<{
  name: string;
  weight: number;
  compute: (input: EudaimoniaInput) => number;
  trend: (input: EudaimoniaInput) => 'up' | 'flat' | 'down';
}> = [
  {
    name: 'Goal Velocity',
    weight: 0.20,
    compute: (i) => i.goalsOnTrack,
    trend: (i) => i.goalsOnTrack > 0.6 ? 'up' : i.goalsOnTrack > 0.3 ? 'flat' : 'down',
  },
  {
    name: 'Agent Efficiency',
    weight: 0.15,
    compute: (i) => i.agentSuccessRate * (1 - i.agentCostNormalized * 0.3),
    trend: (i) => i.agentSuccessRate > 0.8 ? 'up' : i.agentSuccessRate > 0.5 ? 'flat' : 'down',
  },
  {
    name: 'Team Growth',
    weight: 0.15,
    compute: (i) => i.teamBalancedFraction,
    trend: (i) => i.teamBalancedFraction > 0.7 ? 'up' : i.teamBalancedFraction > 0.4 ? 'flat' : 'down',
  },
  {
    name: 'Business Health',
    weight: 0.20,
    compute: (i) => i.businessTrend === 'up' ? 1 : i.businessTrend === 'flat' ? 0.5 : 0.2,
    trend: (i) => i.businessTrend,
  },
  {
    name: 'System Health',
    weight: 0.10,
    compute: (i) => i.systemHealthScore,
    trend: (i) => i.systemHealthScore > 0.7 ? 'up' : i.systemHealthScore > 0.4 ? 'flat' : 'down',
  },
  {
    name: 'Purpose Alignment',
    weight: 0.20,
    compute: (i) => i.purposeAlignmentScore,
    trend: (i) => i.purposeAlignmentScore > 0.7 ? 'up' : i.purposeAlignmentScore > 0.4 ? 'flat' : 'down',
  },
];

// ============================================================================
// EUDAIMONIA COMPUTATION
// ============================================================================

/**
 * Compute the workspace's flourishing score.
 *
 * Pure function. No DB access, no LLM calls. Deterministic.
 */
export function computeEudaimonia(input: EudaimoniaInput): EudaimoniaScore {
  const dimensions: EudaimoniaDimension[] = [];
  let weightedSum = 0;

  for (const dim of DIMENSIONS) {
    const score = Math.max(0, Math.min(1, dim.compute(input)));
    const trend = dim.trend(input);
    weightedSum += score * dim.weight;
    dimensions.push({
      name: dim.name,
      score,
      weight: dim.weight,
      trend,
    });
  }

  const overall = Math.round(Math.max(0, Math.min(100, weightedSum * 100)));
  const healthStatus = classifyHealth(overall);

  return {
    overall,
    dimensions,
    healthStatus,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Generate a human-readable diagnosis of the eudaimonia score.
 * Identifies the weakest dimension and suggests focus.
 */
export function diagnoseEudaimonia(score: EudaimoniaScore): string {
  if (score.dimensions.length === 0) return 'Insufficient data for diagnosis.';

  // Find weakest dimension
  const weakest = [...score.dimensions].sort((a, b) => a.score - b.score)[0];
  const strongest = [...score.dimensions].sort((a, b) => b.score - a.score)[0];

  const parts: string[] = [];

  parts.push(`Workspace health: ${score.healthStatus} (${score.overall}/100).`);

  if (weakest.score < 0.4) {
    parts.push(`Biggest concern: ${weakest.name} is ${weakest.trend === 'down' ? 'declining' : 'low'} (${Math.round(weakest.score * 100)}%).`);
  }

  if (strongest.score > 0.7) {
    parts.push(`Strength: ${strongest.name} at ${Math.round(strongest.score * 100)}%.`);
  }

  const declining = score.dimensions.filter(d => d.trend === 'down');
  if (declining.length > 0) {
    parts.push(`Declining: ${declining.map(d => d.name).join(', ')}.`);
  }

  return parts.join(' ');
}

// ============================================================================
// INTERNAL
// ============================================================================

function classifyHealth(overall: number): EudaimoniaStatus {
  if (overall >= 80) return 'flourishing';
  if (overall >= 60) return 'growing';
  if (overall >= 40) return 'stable';
  if (overall >= 20) return 'struggling';
  return 'critical';
}
