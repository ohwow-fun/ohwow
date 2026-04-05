/**
 * Mesh Router — Brain-Informed Routing (Aristotle's Synergeia)
 *
 * "The whole is greater than the sum of its parts."
 *
 * Extends hardware-only peer scoring with brain experience data.
 * Instead of routing solely by GPU, memory, and queue depth,
 * the mesh router also considers: which device has mastered the
 * required tools? Which device has the best success rate for this
 * work kind? Which device's prediction engine is most accurate?
 */

import type {
  DeviceBrainProfile,
  BrainScoringWeights,
} from './types.js';
import type { WorkKind } from '../work/types.js';

// ============================================================================
// BRAIN-INFORMED SCORING
// ============================================================================

/**
 * Compute additional routing score from brain experience data.
 *
 * Returns a score to ADD to the existing hardware score.
 * When no brain profile exists, returns 0 (backward compat).
 */
export function scoreBrainDimensions(
  profile: DeviceBrainProfile | null,
  context: {
    requiredTool?: string;
    workKind?: WorkKind;
  },
  weights: BrainScoringWeights = {
    toolMastery: 15,
    workKindAffinity: 10,
    predictionAccuracy: 5,
    completionRate: 5,
  },
): { total: number; breakdown: Record<string, number> } {
  if (!profile) {
    return { total: 0, breakdown: {} };
  }

  const breakdown: Record<string, number> = {};
  let total = 0;

  // Tool mastery: does this device excel at the required tool?
  if (context.requiredTool && profile.toolMastery[context.requiredTool]) {
    const mastery = profile.toolMastery[context.requiredTool];
    if (mastery.mastery === 'mastered') {
      breakdown.toolMastery = weights.toolMastery;
    } else if (mastery.mastery === 'familiar') {
      breakdown.toolMastery = Math.round(weights.toolMastery * 0.5);
    } else {
      breakdown.toolMastery = 0;
    }
    total += breakdown.toolMastery;
  }

  // Work kind affinity: how well does this device handle this type of work?
  if (context.workKind && profile.workKindAffinity[context.workKind] !== undefined) {
    const affinity = profile.workKindAffinity[context.workKind];
    breakdown.workKindAffinity = Math.round(affinity * weights.workKindAffinity);
    total += breakdown.workKindAffinity;
  }

  // Prediction accuracy: is this device's brain well-calibrated?
  breakdown.predictionAccuracy = Math.round(profile.predictionAccuracy * weights.predictionAccuracy);
  total += breakdown.predictionAccuracy;

  // Completion rate: reliability signal
  breakdown.completionRate = Math.round(profile.completionRate * weights.completionRate);
  total += breakdown.completionRate;

  return { total, breakdown };
}

/**
 * Infer the primary tool a task will need from its description.
 * Simple heuristic for routing context.
 */
export function inferRequiredTool(taskDescription: string): string | null {
  const text = taskDescription.toLowerCase();
  if (/\b(scrape|website|url|browse)\b/.test(text)) return 'scrape_url';
  if (/\b(search|research|find)\b/.test(text)) return 'deep_research';
  if (/\b(email|send.*mail)\b/.test(text)) return 'send_email';
  if (/\b(whatsapp)\b/.test(text)) return 'send_whatsapp_message';
  if (/\b(telegram)\b/.test(text)) return 'send_telegram_message';
  if (/\b(image|generate.*image|create.*image)\b/.test(text)) return 'generate_image';
  return null;
}
