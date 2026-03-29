/**
 * Phronesis — Practical Wisdom (Aristotle)
 *
 * "Practical wisdom is not concerned with universals only; it must
 * also take cognizance of particulars." — Aristotle, Nicomachean Ethics
 *
 * Phronesis is knowing what to do in THIS situation, not in general.
 * A startup at stage 1 (Launch) needs different work than one at
 * stage 7 (Structure). The phronesis module encodes this wisdom as
 * a lookup table of recommended work allocation per growth stage.
 */

import type { WorkKind, PhronesisRecommendation } from './types.js';

// ============================================================================
// GROWTH STAGE WISDOM TABLE
// ============================================================================

const STAGE_WISDOM: Record<number, {
  name: string;
  allocation: Record<WorkKind, number>;
  antiPatterns: string[];
  rules: Array<{ condition: string; recommendation: string; weight: number }>;
}> = {
  0: {
    name: 'Explore',
    allocation: { theoria: 30, poiesis: 50, praxis: 20 },
    antiPatterns: ['Over-researching without building', 'Perfecting before shipping', 'Analyzing markets instead of talking to customers'],
    rules: [
      { condition: 'Task is pure research with no build component', recommendation: 'Add a "build prototype" follow-up', weight: 0.8 },
    ],
  },
  1: {
    name: 'Launch',
    allocation: { theoria: 15, poiesis: 30, praxis: 55 },
    antiPatterns: ['Building more features instead of selling', 'Redesigning before getting feedback', 'Researching competitors instead of calling leads'],
    rules: [
      { condition: 'Task involves building new features', recommendation: 'Ensure at least 1 customer asked for this', weight: 0.9 },
    ],
  },
  2: {
    name: 'Attract',
    allocation: { theoria: 20, poiesis: 40, praxis: 40 },
    antiPatterns: ['Spreading across too many channels', 'Creating content without distribution strategy', 'Chasing vanity metrics'],
    rules: [
      { condition: 'New marketing channel proposed', recommendation: 'Master existing channels first', weight: 0.7 },
    ],
  },
  3: {
    name: 'Systemize',
    allocation: { theoria: 25, poiesis: 45, praxis: 30 },
    antiPatterns: ['Doing everything manually', 'Not documenting processes', 'Hiring before systematizing'],
    rules: [
      { condition: 'Repeated manual task detected', recommendation: 'Create an automation or SOP', weight: 0.9 },
    ],
  },
  4: {
    name: 'Focus',
    allocation: { theoria: 30, poiesis: 25, praxis: 45 },
    antiPatterns: ['Adding new product lines', 'Serving non-ideal customers', 'Spreading budget thin'],
    rules: [
      { condition: 'New offering proposed', recommendation: 'Cut bottom 20% of offerings first', weight: 0.8 },
    ],
  },
  5: {
    name: 'Expand',
    allocation: { theoria: 25, poiesis: 35, praxis: 40 },
    antiPatterns: ['Expanding without validating new offering', 'Ignoring unit economics', 'Hiring ahead of revenue'],
    rules: [
      { condition: 'Expansion into new market', recommendation: 'Validate with 10 customers before scaling', weight: 0.8 },
    ],
  },
  6: {
    name: 'Refine',
    allocation: { theoria: 35, poiesis: 30, praxis: 35 },
    antiPatterns: ['Cutting quality for margin', 'Ignoring customer feedback', 'Over-optimizing too early'],
    rules: [
      { condition: 'Cost-cutting initiative', recommendation: 'Measure quality impact before and after', weight: 0.7 },
    ],
  },
  7: {
    name: 'Structure',
    allocation: { theoria: 20, poiesis: 25, praxis: 55 },
    antiPatterns: ['Micromanaging', 'Not delegating decisions', 'Building processes around individuals'],
    rules: [
      { condition: 'Founder doing execution work', recommendation: 'Delegate to agent or team member', weight: 0.9 },
    ],
  },
  8: {
    name: 'Dominate',
    allocation: { theoria: 30, poiesis: 30, praxis: 40 },
    antiPatterns: ['Diversifying instead of deepening', 'Chasing adjacent markets', 'Complacency with market position'],
    rules: [
      { condition: 'Adjacent market entry proposed', recommendation: 'Go deeper in existing niche first', weight: 0.7 },
    ],
  },
  9: {
    name: 'Compound',
    allocation: { theoria: 35, poiesis: 25, praxis: 40 },
    antiPatterns: ['Resting on laurels', 'Stopping innovation', 'Bureaucratic slowdown'],
    rules: [
      { condition: 'Innovation budget reduced', recommendation: 'Maintain innovation investment to compound growth', weight: 0.8 },
    ],
  },
};

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get the practical wisdom recommendation for a growth stage.
 */
export function getPhronesisRecommendation(stageId: number): PhronesisRecommendation {
  const wisdom = STAGE_WISDOM[stageId] ?? STAGE_WISDOM[0];
  return {
    stageId,
    stageName: wisdom.name,
    allocation: wisdom.allocation,
    priorityRules: wisdom.rules,
    antiPatterns: wisdom.antiPatterns,
  };
}

/**
 * Score how appropriate a task's work kind is for the current stage.
 *
 * If the workspace is already over-indexed on a work kind (doing too much
 * of it relative to the recommended allocation), new tasks of that kind
 * get a lower score to rebalance.
 *
 * @param workKind - The task's classified work kind
 * @param stageId - Current growth stage
 * @param currentAllocation - Current actual work distribution (0-100 per kind)
 * @returns 0-1 score (higher = more appropriate)
 */
export function scoreTaskPhronesis(
  workKind: WorkKind,
  stageId: number,
  currentAllocation?: Record<WorkKind, number>,
): number {
  const wisdom = STAGE_WISDOM[stageId] ?? STAGE_WISDOM[0];
  const recommended = wisdom.allocation[workKind];

  // Base score: how much the stage recommends this kind of work
  let score = recommended / 100;

  // Rebalancing: if current allocation exceeds recommendation, lower the score
  if (currentAllocation) {
    const current = currentAllocation[workKind] ?? 0;
    const excess = current - recommended;
    if (excess > 0) {
      // Penalize proportionally to excess (10% over → 0.1 penalty)
      score *= Math.max(0.3, 1 - excess / 100);
    } else {
      // Bonus for under-represented work kinds (up to 20%)
      score *= Math.min(1.2, 1 + Math.abs(excess) / 200);
    }
  }

  return Math.max(0, Math.min(1, score));
}
