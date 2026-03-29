/**
 * Synergeia — Working Together (Aristotle)
 *
 * "The whole is greater than the sum of its parts."
 * — Aristotle, Metaphysics
 *
 * Synergeia models how humans and agents collaborate. The best work
 * happens when the right human is paired with the right agent for
 * the right task. This module tracks collaboration patterns and
 * recommends improvements.
 */

import type { SynergeiaProfile, SynergeiaInput, CollaborationPattern } from './types.js';

// ============================================================================
// SYNERGEIA COMPUTATION
// ============================================================================

/**
 * Compute collaboration profiles for all human-agent pairs.
 *
 * Pure function. Takes pre-fetched completed task data.
 */
export function computeSynergeia(input: SynergeiaInput): SynergeiaProfile[] {
  // Group tasks by (pointPersonId, agentId) pairs
  const pairs = new Map<string, {
    humanId: string;
    humanName: string;
    agentId: string;
    agentName: string;
    tasks: typeof input.completedTasks;
  }>();

  for (const task of input.completedTasks) {
    if (!task.pointPersonId || !task.agentId) continue;

    const key = `${task.pointPersonId}:${task.agentId}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        humanId: task.pointPersonId,
        humanName: task.pointPersonName ?? 'Unknown',
        agentId: task.agentId,
        agentName: task.agentName,
        tasks: [],
      });
    }
    pairs.get(key)!.tasks.push(task);
  }

  // Compute profile for each pair
  const profiles: SynergeiaProfile[] = [];

  for (const [, pair] of pairs) {
    if (pair.tasks.length < 2) continue; // need at least 2 tasks for meaningful data

    // Effectiveness = avg truth score / 100
    const truthScores = pair.tasks
      .filter(t => t.truthScore !== null)
      .map(t => t.truthScore!);
    const effectivenessScore = truthScores.length > 0
      ? truthScores.reduce((a, b) => a + b, 0) / truthScores.length / 100
      : 0.5;

    // Review time = avg time between completion and approval
    const reviewTimes: number[] = [];
    for (const task of pair.tasks) {
      if (task.completedAt && task.approvedAt) {
        const completedMs = new Date(task.completedAt).getTime();
        const approvedMs = new Date(task.approvedAt).getTime();
        const diff = approvedMs - completedMs;
        if (diff >= 0) reviewTimes.push(diff);
      }
    }
    const avgReviewTimeMs = reviewTimes.length > 0
      ? reviewTimes.reduce((a, b) => a + b, 0) / reviewTimes.length
      : 0;

    // Accuracy = fraction approved without rejection
    const approved = pair.tasks.filter(t => t.approvedAt).length;
    const rejected = pair.tasks.filter(t => t.rejectedAt).length;
    const total = approved + rejected;
    const agentAccuracy = total > 0 ? approved / total : 0.5;

    // Classify pattern
    const pattern = classifyPattern(avgReviewTimeMs, agentAccuracy, pair.tasks.length);

    // Generate recommendation
    const recommendation = generateRecommendation(
      pair.humanName,
      pair.agentName,
      pattern,
      effectivenessScore,
      avgReviewTimeMs,
      agentAccuracy,
    );

    profiles.push({
      humanId: pair.humanId,
      humanName: pair.humanName,
      agentId: pair.agentId,
      agentName: pair.agentName,
      pattern,
      effectivenessScore,
      avgReviewTimeMs,
      agentAccuracyWithHuman: agentAccuracy,
      totalCollaborations: pair.tasks.length,
      recommendation,
    });
  }

  // Sort by effectiveness (highest first)
  profiles.sort((a, b) => b.effectivenessScore - a.effectivenessScore);

  return profiles;
}

// ============================================================================
// INTERNAL
// ============================================================================

function classifyPattern(
  avgReviewTimeMs: number,
  accuracy: number,
  taskCount: number,
): CollaborationPattern {
  const fiveMinutes = 5 * 60 * 1000;
  const oneHour = 60 * 60 * 1000;

  // No reviews at all → autonomous
  if (avgReviewTimeMs === 0 && taskCount >= 3) return 'autonomous';

  // Very fast reviews + high accuracy → delegation
  if (avgReviewTimeMs < fiveMinutes && accuracy > 0.8) return 'delegation';

  // Slow reviews or low accuracy → iteration needed
  if (avgReviewTimeMs > oneHour || accuracy < 0.6) return 'iteration';

  // Moderate review time → active review pattern
  return 'review';
}

function generateRecommendation(
  humanName: string,
  agentName: string,
  pattern: CollaborationPattern,
  effectiveness: number,
  reviewTime: number,
  accuracy: number,
): string {
  const reviewMinutes = Math.round(reviewTime / 60000);

  switch (pattern) {
    case 'autonomous':
      return `${agentName} works independently with high reliability. Consider increasing autonomy level.`;
    case 'delegation':
      return `Strong delegation pair: ${humanName} trusts ${agentName} (${reviewMinutes}min avg review). Consider expanding scope.`;
    case 'iteration':
      if (accuracy < 0.6) {
        return `${agentName} needs improvement when working with ${humanName} (${Math.round(accuracy * 100)}% accuracy). Review agent system prompt and examples.`;
      }
      return `${humanName} takes ${reviewMinutes}min avg to review ${agentName}'s work. Consider clearer task specifications to reduce review cycles.`;
    case 'review':
      return `Healthy review pattern between ${humanName} and ${agentName}. Effectiveness: ${Math.round(effectiveness * 100)}%.`;
    case 'pair':
      return `${humanName} and ${agentName} work in pair mode. High collaboration intensity.`;
  }
}
