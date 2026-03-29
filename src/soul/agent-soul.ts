/**
 * Agent Soul Computation
 *
 * Aristotle: "The soul is the first actuality of a natural body that has
 * life potentially." An agent's soul is not what it *is* but what it *does*,
 * the shape of its activity over time.
 *
 * We compute tripartite balance, values, shadow, growth, and an emerging
 * identity statement — all from observable behavior, never from self-report.
 */

import type { AgentSoul, AgentSoulInput, Tripartite } from './types.js';
import { detectShadows } from './shadow.js';
import { computeGrowthArc, computeGrowthSnapshot } from './growth-arc.js';

/**
 * Extract the top N unique value keywords from a set of texts.
 * Uses word frequency to find recurring themes.
 */
function extractValues(texts: string[], count: number): string[] {
  const stopWords = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has',
    'was', 'were', 'been', 'being', 'will', 'would', 'could', 'should',
    'their', 'they', 'them', 'then', 'than', 'what', 'when', 'where',
    'which', 'while', 'about', 'into', 'through', 'during', 'before',
    'after', 'above', 'below', 'between', 'each', 'every', 'both',
    'does', 'done', 'doing', 'make', 'made', 'just', 'also', 'only',
    'very', 'more', 'most', 'some', 'such', 'other', 'over', 'under',
  ]);

  const freq = new Map<string, number>();

  for (const text of texts) {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));

    for (const word of words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([word]) => word);
}

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
 * Build a deterministic identity sentence from the dominant tripartite
 * faculty and the top value.
 */
function buildEmergingIdentity(
  name: string,
  dominant: string,
  topValue: string | undefined
): string {
  const dispositions: Record<string, string> = {
    reason: 'analytical and principle-driven',
    spirit: 'ambitious and driven',
    appetite: 'efficient and pattern-oriented',
  };

  const disposition = dispositions[dominant] ?? 'developing';
  const valuePart = topValue ? `, centered on ${topValue}` : '';

  return `${name} is ${disposition}${valuePart}.`;
}

/**
 * Compute the full soul of an agent from observable behavior data.
 */
export function computeAgentSoul(input: AgentSoulInput): AgentSoul {
  // Tripartite: reason from principles, spirit from drive, appetite from habits
  const rawReason = input.principleCount * input.avgPrincipleConfidence;
  const completionRate = input.totalTasks > 0
    ? input.completedTasks / input.totalTasks
    : 0;
  const rawSpirit = completionRate * Math.min(1, input.taskThroughputPerDay / 10);
  const rawAppetite = input.toolReuseRate * (1 - input.toolDiversity);

  const tripartite = normalizeTripartite(rawReason, rawSpirit, rawAppetite);

  // Values: distilled from principles and positive feedback
  const valueSources = [...input.principleTexts, ...input.positiveMemories];
  const values = extractValues(valueSources, 5);

  // Shadow: blind spots from negative patterns
  const shadow = detectShadows(input.negativeMemories, input.failureCategories);

  // Growth: from success rate trend
  const snapshots = input.successRateTrend.map((rate, i) =>
    computeGrowthSnapshot({
      competence: rate,
      autonomy: Math.min(1, input.toolDiversity + (i * 0.05)),
      specialization: input.toolReuseRate,
      relationshipHealth: completionRate,
    })
  );
  const growthArc = computeGrowthArc(snapshots);

  // Emerging identity
  const emergingIdentity = buildEmergingIdentity(
    input.agentName,
    tripartite.dominant,
    values[0]
  );

  // Confidence: higher when more data is available
  const dataPoints = input.totalTasks + input.principleCount + input.positiveMemories.length;
  const confidence = Math.min(0.95, 0.3 + Math.log10(Math.max(1, dataPoints)) * 0.2);

  return {
    agentId: input.agentId,
    agentName: input.agentName,
    tripartite,
    values,
    shadow,
    growthArc,
    emergingIdentity,
    confidence,
    computedAt: new Date().toISOString(),
  };
}
