/**
 * Cognitive Load — Real-Time Capacity Estimation
 *
 * How much can this person handle right now?
 * When the system detects overload, it stops adding tasks
 * and starts filtering, prioritizing, and batching.
 */

import type { CognitiveLoadState, CognitiveLoadInput, CognitiveLoadLevel, LoadRecommendation } from './types.js';

// ============================================================================
// THRESHOLDS
// ============================================================================

const THRESHOLDS: Record<CognitiveLoadLevel, {
  maxApprovals: number;
  maxTasks: number;
  maxDecisions: number;
}> = {
  low: { maxApprovals: 1, maxTasks: 2, maxDecisions: 3 },
  moderate: { maxApprovals: 3, maxTasks: 5, maxDecisions: 5 },
  high: { maxApprovals: 5, maxTasks: 10, maxDecisions: 8 },
  overloaded: { maxApprovals: Infinity, maxTasks: Infinity, maxDecisions: Infinity },
};

const RECOMMENDATIONS: Record<CognitiveLoadLevel, LoadRecommendation> = {
  low: 'add_work',
  moderate: 'add_work',
  high: 'hold',
  overloaded: 'critical_only',
};

// ============================================================================
// COGNITIVE LOAD COMPUTATION
// ============================================================================

/**
 * Estimate the human's current cognitive load.
 *
 * Pure function. No DB access. Deterministic.
 */
export function computeCognitiveLoad(input: CognitiveLoadInput): CognitiveLoadState {
  const { openApprovals, openTasks, recentDecisionsCount } = input;

  let level: CognitiveLoadLevel = 'low';

  if (
    openApprovals > THRESHOLDS.high.maxApprovals ||
    openTasks > THRESHOLDS.high.maxTasks ||
    recentDecisionsCount > THRESHOLDS.high.maxDecisions
  ) {
    level = 'overloaded';
  } else if (
    openApprovals > THRESHOLDS.moderate.maxApprovals ||
    openTasks > THRESHOLDS.moderate.maxTasks ||
    recentDecisionsCount > THRESHOLDS.moderate.maxDecisions
  ) {
    level = 'high';
  } else if (
    openApprovals > THRESHOLDS.low.maxApprovals ||
    openTasks > THRESHOLDS.low.maxTasks ||
    recentDecisionsCount > THRESHOLDS.low.maxDecisions
  ) {
    level = 'moderate';
  }

  // Estimated capacity: 1.0 = fully available, 0.0 = completely overloaded
  const approvalLoad = Math.min(1, openApprovals / 10);
  const taskLoad = Math.min(1, openTasks / 20);
  const decisionLoad = Math.min(1, recentDecisionsCount / 15);
  const estimatedCapacity = Math.max(0, 1 - Math.max(approvalLoad, taskLoad, decisionLoad));

  return {
    level,
    openApprovals,
    openTasks,
    recentDecisions: recentDecisionsCount,
    estimatedCapacity,
    recommendation: RECOMMENDATIONS[level],
  };
}

/**
 * Should the system add more work to this person's plate?
 */
export function shouldAddWork(load: CognitiveLoadState): boolean {
  return load.recommendation === 'add_work';
}
