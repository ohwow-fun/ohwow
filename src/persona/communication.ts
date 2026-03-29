/**
 * Communication Style — Inference from Message Patterns
 *
 * Does this person prefer bullet points or narratives?
 * Do they decide fast or slow? The system learns by watching.
 */

import type { CommunicationProfile, CommunicationInput, CommunicationLength, DecisionStyle } from './types.js';

// ============================================================================
// THRESHOLDS
// ============================================================================

const LENGTH_THRESHOLDS: Record<CommunicationLength, [number, number]> = {
  brief: [0, 20],
  moderate: [20, 80],
  detailed: [80, Infinity],
};

const DECISION_THRESHOLDS: Record<DecisionStyle, [number, number]> = {
  fast: [0, 5 * 60 * 1000],           // < 5 minutes
  deliberate: [5 * 60 * 1000, 60 * 60 * 1000], // 5 min - 1 hour
  cautious: [60 * 60 * 1000, Infinity],        // > 1 hour
};

// ============================================================================
// COMMUNICATION STYLE INFERENCE
// ============================================================================

/**
 * Infer communication style from message patterns.
 *
 * Pure function. No DB access. Deterministic.
 */
export function computeCommunicationProfile(input: CommunicationInput): CommunicationProfile {
  // Average message word count
  const avgWords = input.messages.length > 0
    ? input.messages.reduce((sum, m) => sum + m.wordCount, 0) / input.messages.length
    : 40; // default moderate

  // Preferred length
  let preferredLength: CommunicationLength = 'moderate';
  for (const [length, [min, max]] of Object.entries(LENGTH_THRESHOLDS) as [CommunicationLength, [number, number]][]) {
    if (avgWords >= min && avgWords < max) {
      preferredLength = length;
      break;
    }
  }

  // Bullets preference
  const prefersBullets = input.briefingFormat === 'bullets'
    || input.briefingFormat === 'digest'
    || preferredLength === 'brief';

  // Average response latency
  const latencies: number[] = [];
  for (const msg of input.messages) {
    if (msg.timestamp > 0) {
      // Rough: use message timestamp spacing as response latency proxy
      latencies.push(msg.timestamp);
    }
  }
  // Calculate average gap between consecutive messages
  let avgLatency = 30000; // default 30 seconds
  if (latencies.length > 1) {
    const gaps: number[] = [];
    const sorted = [...latencies].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(sorted[i] - sorted[i - 1]);
    }
    if (gaps.length > 0) {
      avgLatency = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    }
  }

  // Decision style from approval timing
  let decisionStyle: DecisionStyle = 'deliberate';
  if (input.approvals.length > 0) {
    const approvalTimes = input.approvals.map(a => a.approvedAt - a.taskCompletedAt);
    const avgApprovalTime = approvalTimes.reduce((a, b) => a + b, 0) / approvalTimes.length;

    for (const [style, [min, max]] of Object.entries(DECISION_THRESHOLDS) as [DecisionStyle, [number, number]][]) {
      if (avgApprovalTime >= min && avgApprovalTime < max) {
        decisionStyle = style;
        break;
      }
    }
  }

  return {
    preferredLength,
    averageMessageWords: Math.round(avgWords),
    prefersBullets,
    responseLatencyMs: Math.round(avgLatency),
    decisionStyle,
  };
}

/**
 * Format a persona communication summary for prompt injection.
 */
export function formatCommunicationGuidance(profile: CommunicationProfile): string {
  const parts: string[] = [];

  if (profile.preferredLength === 'brief') {
    parts.push('Keep responses concise and to the point.');
  } else if (profile.preferredLength === 'detailed') {
    parts.push('Provide thorough, detailed responses.');
  }

  if (profile.prefersBullets) {
    parts.push('Use bullet points for lists.');
  }

  if (profile.decisionStyle === 'fast') {
    parts.push('Present decisions clearly. This person decides quickly.');
  } else if (profile.decisionStyle === 'cautious') {
    parts.push('Provide full context for decisions. This person prefers to think carefully.');
  }

  return parts.join(' ');
}
