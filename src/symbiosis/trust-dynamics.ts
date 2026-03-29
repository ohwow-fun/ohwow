/**
 * Trust Dynamics — Evolving trust per domain
 *
 * Trust is earned through consistent outcomes, not granted by configuration
 *
 * Trust is asymmetric by design: it takes 5 consecutive successes to
 * raise trust by 0.05, but a single failure drops it by 0.1. This
 * mirrors how real trust works. Building it is slow and steady.
 * Losing it is fast. Rebuilding it is possible but requires patience.
 *
 * Pure functions. No LLM. No database. Just math grounded in
 * behavioral economics and common sense.
 */

import type { DomainTrust } from './types.js';

/** How much trust increases when the auto-promote threshold is met. */
const TRUST_INCREMENT = 0.05;

/** How much trust decreases on a single failure. */
const TRUST_DECREMENT = 0.1;

/** Minimum trust floor. Even after failures, trust never goes below this. */
const TRUST_FLOOR = 0.0;

/** Maximum trust ceiling. */
const TRUST_CEILING = 1.0;

/**
 * Update domain trust after a task outcome.
 *
 * 5 consecutive successes → trust += 0.05
 * 1 failure → trust -= 0.1, consecutive counter resets
 *
 * @param current - Current domain trust state
 * @param success - Whether the latest task succeeded
 * @returns Updated domain trust (new object, never mutates)
 */
export function updateDomainTrust(current: DomainTrust, success: boolean): DomainTrust {
  if (success) {
    const newConsecutive = current.consecutiveSuccesses + 1;
    const shouldPromote = newConsecutive >= current.autoPromoteThreshold;

    return {
      ...current,
      consecutiveSuccesses: shouldPromote ? 0 : newConsecutive,
      trustLevel: shouldPromote
        ? Math.min(current.trustLevel + TRUST_INCREMENT, TRUST_CEILING)
        : current.trustLevel,
    };
  }

  // Failure path
  return {
    ...current,
    consecutiveSuccesses: 0,
    trustLevel: Math.max(current.trustLevel - TRUST_DECREMENT, TRUST_FLOOR),
    lastFailure: new Date().toISOString(),
  };
}

/**
 * Compute trust levels per domain from a flat task history.
 *
 * Tasks are processed in array order (assumed chronological).
 * Each domain starts at 0.5 trust with default thresholds.
 *
 * @param tasks - Array of task outcomes with domain and success flag
 * @returns Array of DomainTrust, one per unique domain
 */
export function computeTrustFromHistory(
  tasks: Array<{ domain: string; success: boolean }>
): DomainTrust[] {
  const trustMap = new Map<string, DomainTrust>();

  for (const task of tasks) {
    const existing = trustMap.get(task.domain) ?? createDefaultTrust(task.domain);
    trustMap.set(task.domain, updateDomainTrust(existing, task.success));
  }

  return Array.from(trustMap.values());
}

/**
 * Create a default trust entry for a new domain.
 * Starts at 0.5 (neutral) with no history.
 */
function createDefaultTrust(domain: string): DomainTrust {
  return {
    domain,
    trustLevel: 0.5,
    consecutiveSuccesses: 0,
    lastFailure: null,
    autoPromoteThreshold: 5,
  };
}
