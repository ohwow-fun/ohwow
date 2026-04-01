/**
 * Tolerance — Self/non-self distinction and autoimmune detection
 * Prevents the immune system from attacking legitimate inputs.
 */

import type { AutoimmuneIndicator } from './types.js';

/**
 * Assess how "foreign" an input looks relative to known patterns.
 * Returns a score from 0 (self/familiar) to 1 (foreign/unknown).
 */
export function assessSelfNonSelf(input: string, knownPatterns: string[]): number {
  if (knownPatterns.length === 0) return 0.5; // unknown = neutral

  const lowerInput = input.toLowerCase();
  let matchCount = 0;

  for (const pattern of knownPatterns) {
    try {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(lowerInput)) {
        matchCount++;
      }
    } catch {
      // Invalid regex, treat as literal match
      if (lowerInput.includes(pattern.toLowerCase())) {
        matchCount++;
      }
    }
  }

  // More matches = more familiar = more "self"
  const familiarity = Math.min(1, matchCount / Math.max(1, knownPatterns.length));
  return 1 - familiarity;
}

/**
 * Detect autoimmune behavior: the immune system blocking legitimate inputs.
 * If the false positive rate exceeds 20%, flag autoimmune condition.
 */
export function detectAutoimmune(
  recentDetections: { detected: boolean; wasFalsePositive: boolean }[],
): AutoimmuneIndicator {
  if (recentDetections.length === 0) {
    return {
      detected: false,
      falsePositiveRate: 0,
      blockedLegitimate: 0,
      recommendation: 'Insufficient data',
    };
  }

  const detections = recentDetections.filter(d => d.detected);
  if (detections.length === 0) {
    return {
      detected: false,
      falsePositiveRate: 0,
      blockedLegitimate: 0,
      recommendation: 'No detections to evaluate',
    };
  }

  const falsePositives = detections.filter(d => d.wasFalsePositive);
  const falsePositiveRate = falsePositives.length / detections.length;
  const blockedLegitimate = falsePositives.length;

  const detected = falsePositiveRate > 0.2;

  return {
    detected,
    falsePositiveRate,
    blockedLegitimate,
    recommendation: detected
      ? 'Reduce sensitivity: too many legitimate inputs are being blocked. Review and relax threat signatures.'
      : 'Immune response is well-calibrated',
  };
}
