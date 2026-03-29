/**
 * Relationship Soul — The Bond Between Human and Agent
 *
 * The relationship itself has a soul. Not the human's soul, not the
 * agent's soul, but the shape of their interaction. A micromanager
 * paired with a high-autonomy agent creates a different soul than
 * a delegator paired with the same agent.
 *
 * Bond strength, mutual adaptation, shared context, and health
 * trajectory are the four pillars.
 */

import type { RelationshipSoul, RelationshipSoulInput } from './types.js';
import { computeGrowthArc, computeGrowthSnapshot } from './growth-arc.js';

/**
 * Normalize a count to 0-1 using logarithmic scaling.
 * 1 interaction = ~0, 100 interactions = ~0.67, 1000 = ~1.
 */
function normalizeCount(count: number, scale = 1000): number {
  if (count <= 0) return 0;
  return Math.min(1, Math.log10(count + 1) / Math.log10(scale + 1));
}

/**
 * Detect whether review times are trending downward (increasing comfort).
 * Returns 0-1 where 1 means strong downward trend.
 */
function reviewTimeDeclineFactor(trend: number[]): number {
  if (trend.length < 2) return 0.5;

  let declines = 0;
  for (let i = 1; i < trend.length; i++) {
    if (trend[i] < trend[i - 1]) declines++;
  }

  return declines / (trend.length - 1);
}

/**
 * Detect if rejection reasons are trending down over time.
 * Fewer recent rejections = agent is adapting.
 */
function detectAgentAdaptation(
  memoriesForHuman: string[]
): string[] {
  if (memoriesForHuman.length === 0) return [];

  // Extract recurring themes from what the agent remembers about the human
  const freq = new Map<string, number>();
  for (const memory of memoriesForHuman) {
    const words = memory
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3);

    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  return Array.from(freq.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

/**
 * Detect what the human has adapted to about the agent.
 * Declining rejection reasons suggest the human learned the agent's patterns.
 */
function detectHumanAdaptation(rejectionReasons: string[]): string[] {
  if (rejectionReasons.length === 0) return ['full trust (no rejections)'];

  // Themes from rejection reasons = what the human pays attention to
  const freq = new Map<string, number>();
  for (const reason of rejectionReasons) {
    const words = reason
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3);

    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => `aware of ${word} patterns`);
}

/**
 * Generate a deterministic recommendation from bond metrics.
 */
function generateRecommendation(
  bondStrength: number,
  reviewDecline: number,
  uniqueTaskCount: number
): string {
  if (bondStrength > 0.8 && reviewDecline > 0.6) {
    return 'Strong partnership. Consider expanding this agent\'s autonomy and task scope.';
  }

  if (bondStrength > 0.6 && reviewDecline > 0.4) {
    return 'Growing trust. The relationship is maturing well. Continue current patterns.';
  }

  if (bondStrength > 0.4) {
    if (uniqueTaskCount > 3) {
      return 'Diverse collaboration with room to deepen trust. More consistent approvals would strengthen the bond.';
    }
    return 'Moderate bond. Consider diversifying the types of tasks this agent handles.';
  }

  if (bondStrength > 0.2) {
    return 'Early relationship. Give it time and consistent interaction to build mutual understanding.';
  }

  return 'Minimal bond. This pair may need more shared work to develop trust.';
}

/**
 * Compute the soul of the relationship between a human and an agent.
 */
export function computeRelationshipSoul(
  input: RelationshipSoulInput
): RelationshipSoul {
  // Bond strength: weighted composite
  const approvalWeight = 0.4;
  const interactionWeight = 0.2;
  const reviewDeclineWeight = 0.2;
  const uniqueTaskWeight = 0.2;

  const normalizedInteractions = normalizeCount(input.interactionCount);
  const reviewDecline = reviewTimeDeclineFactor(input.reviewTimeTrend);
  const normalizedUniqueTasks = normalizeCount(input.uniqueTaskTypes.length, 20);

  const bondStrength = Math.min(1, Math.max(0,
    input.approvalRate * approvalWeight +
    normalizedInteractions * interactionWeight +
    reviewDecline * reviewDeclineWeight +
    normalizedUniqueTasks * uniqueTaskWeight
  ));

  // Mutual adaptation
  const agentAdaptedTo = detectAgentAdaptation(input.agentMemoriesForHuman);
  const humanAdaptedTo = detectHumanAdaptation(input.humanRejectionReasons);

  // Shared context: the unique task types are the relationship's specialization
  const sharedContext = input.uniqueTaskTypes;

  // Health arc: single snapshot from current metrics
  const snapshot = computeGrowthSnapshot({
    competence: input.approvalRate,
    autonomy: reviewDecline,
    specialization: normalizedUniqueTasks,
    relationshipHealth: bondStrength,
  });
  const healthArc = computeGrowthArc([snapshot]);

  // Recommendation
  const recommendation = generateRecommendation(
    bondStrength,
    reviewDecline,
    input.uniqueTaskTypes.length
  );

  return {
    humanId: input.humanId,
    agentId: input.agentId,
    bondStrength,
    mutualAdaptation: {
      agentAdaptedTo,
      humanAdaptedTo,
    },
    sharedContext,
    healthArc,
    recommendation,
    computedAt: new Date().toISOString(),
  };
}
