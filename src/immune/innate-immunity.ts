/**
 * Innate Immunity — Static pattern-based threat detection
 * First line of defense: scans input against known threat signatures.
 */

import type { ThreatDetection, ThreatSignature } from './types.js';
import { INNATE_SIGNATURES } from './types.js';

/**
 * Scan input text against innate threat signatures.
 * Case-insensitive matching; returns first match with highest severity.
 * No match returns an allow recommendation.
 */
export function scanInnate(
  input: string,
  additionalSignatures: ThreatSignature[] = [],
): ThreatDetection {
  const lowerInput = input.toLowerCase();

  // Combine innate + learned signatures, sort by severity descending
  const allSignatures = [
    ...INNATE_SIGNATURES.map((s, i) => ({ ...s, id: `innate-${i}` })),
    ...additionalSignatures,
  ].sort((a, b) => b.severity - a.severity);

  for (const sig of allSignatures) {
    const regex = new RegExp(sig.pattern, 'i');
    if (regex.test(lowerInput)) {
      const recommendation = sig.severity >= 0.85
        ? 'block'
        : sig.severity >= 0.7
          ? 'flag'
          : 'allow';

      return {
        detected: true,
        pathogenType: sig.pathogenType,
        confidence: sig.severity * (1 - sig.falsePositiveRate),
        matchedSignature: sig.pattern,
        recommendation,
        reason: `Innate pattern match: "${sig.pattern}" (severity: ${sig.severity})`,
      };
    }
  }

  return {
    detected: false,
    pathogenType: null,
    confidence: 0,
    matchedSignature: null,
    recommendation: 'allow',
    reason: 'No innate threat patterns detected',
  };
}
