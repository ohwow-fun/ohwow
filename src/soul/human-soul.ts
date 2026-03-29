/**
 * Human Soul Computation
 *
 * The human soul is harder to compute than the agent's because humans
 * don't have task logs. We infer from *how they interact with their agents*:
 * review speed, approval patterns, stated vs revealed values, delegation
 * habits.
 *
 * The gap between stated values and revealed values is the most
 * philosophically interesting output. "I want to delegate" but never
 * approving without review reveals a trust gap, not a lie.
 */

import type {
  HumanSoul,
  HumanSoulInput,
  LeadershipStyle,
  Tripartite,
} from './types.js';
import { detectShadows } from './shadow.js';
import { computeGrowthArc, computeGrowthSnapshot } from './growth-arc.js';

/**
 * Normalize three raw scores so they sum to 1.
 */
function normalizeTripartite(
  rawReason: number,
  rawSpirit: number,
  rawAppetite: number
): Tripartite {
  const total = rawReason + rawSpirit + rawAppetite;
  if (total === 0) {
    return {
      reason: 0.33,
      spirit: 0.34,
      appetite: 0.33,
      dominant: 'spirit',
      balanced: true,
    };
  }

  const reason = rawReason / total;
  const spirit = rawSpirit / total;
  const appetite = rawAppetite / total;

  const values: Array<[string, number]> = [
    ['reason', reason],
    ['spirit', spirit],
    ['appetite', appetite],
  ];
  values.sort((a, b) => b[1] - a[1]);
  const dominant = values[0][0] as 'reason' | 'spirit' | 'appetite';

  const balanced =
    reason <= 0.6 && spirit <= 0.6 && appetite <= 0.6 &&
    reason >= 0.2 && spirit >= 0.2 && appetite >= 0.2;

  return { reason, spirit, appetite, dominant, balanced };
}

/**
 * Cluster rejection reasons by keyword overlap to reveal values.
 */
function clusterReasons(reasons: string[]): string[] {
  if (reasons.length === 0) return [];

  const freq = new Map<string, number>();
  for (const reason of reasons) {
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
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

/**
 * Compare stated values with revealed values to find gaps.
 */
function computeValueGap(
  stated: string[],
  revealed: string[]
): Array<{ stated: string; revealed: string; gap: string }> {
  const gaps: Array<{ stated: string; revealed: string; gap: string }> = [];
  const revealedSet = new Set(revealed.map((v) => v.toLowerCase()));
  const statedSet = new Set(stated.map((v) => v.toLowerCase()));

  // Stated values not reflected in behavior
  for (const s of stated) {
    if (!revealedSet.has(s.toLowerCase())) {
      gaps.push({
        stated: s,
        revealed: '(not observed in behavior)',
        gap: `States "${s}" but behavior does not reflect it yet.`,
      });
    }
  }

  // Revealed values not stated
  for (const r of revealed) {
    if (!statedSet.has(r.toLowerCase())) {
      gaps.push({
        stated: '(not stated)',
        revealed: r,
        gap: `Behavior reveals "${r}" as a value, though it was never stated.`,
      });
    }
  }

  return gaps;
}

/**
 * Infer leadership style from delegation patterns and review behavior.
 */
function inferLeadershipStyle(input: HumanSoulInput): LeadershipStyle {
  // Low delegation + long review = micromanager
  if (input.delegationRate < 0.3 && input.avgReviewTimeMs > 30000) {
    return 'micromanager';
  }

  // High delegation + fast trust evolution = delegator
  if (input.delegationRate > 0.7 && input.trustEvolutionSpeed > 0.5) {
    return 'delegator';
  }

  // Low engagement = absent
  if (input.engagementFrequency < 0.5) {
    return 'absent';
  }

  // Middle ground = collaborator
  return 'collaborator';
}

/**
 * Compute the full soul of a human from their interaction patterns.
 */
export function computeHumanSoul(input: HumanSoulInput): HumanSoul {
  // Tripartite: reason from deliberation, spirit from engagement, appetite from batching
  // Longer review time (up to 60s normalized) = more reason
  const rawReason = Math.min(1, input.avgReviewTimeMs / 60000);
  // Higher engagement frequency (up to 20/day) = more spirit
  const rawSpirit = Math.min(1, input.engagementFrequency / 20);
  // Higher batch approval = more appetite (shortcut-seeking)
  const rawAppetite = input.batchApprovalRate;

  const tripartite = normalizeTripartite(rawReason, rawSpirit, rawAppetite);

  // Values
  const revealedValues = clusterReasons(input.rejectionReasons);
  const statedSources = [...input.statedGoals];
  if (input.founderFocus) statedSources.push(input.founderFocus);
  const statedValues = statedSources.slice(0, 5);
  const valueGap = computeValueGap(statedValues, revealedValues);

  // Shadow
  const shadow = detectShadows(input.rejectionReasons, []);

  // Growth: track evolution as an AI collaborator
  // Single snapshot from current state; historical snapshots would accumulate over time
  const snapshot = computeGrowthSnapshot({
    competence: input.approvalRate,
    autonomy: input.delegationRate,
    specialization: Math.min(1, input.avgMessageLength / 500),
    relationshipHealth: 1 - Math.abs(input.approvalRate - 0.8),
  });
  const growthArc = computeGrowthArc([snapshot]);

  // Leadership style
  const leadershipStyle = inferLeadershipStyle(input);

  // Confidence: more interactions = more confident assessment
  const dataPoints = input.rejectionReasons.length + input.statedGoals.length;
  const confidence = Math.min(0.95, 0.3 + Math.log10(Math.max(1, dataPoints)) * 0.2);

  return {
    userId: input.userId,
    tripartite,
    revealedValues,
    statedValues,
    valueGap,
    shadow,
    growthArc,
    leadershipStyle,
    confidence,
    computedAt: new Date().toISOString(),
  };
}
