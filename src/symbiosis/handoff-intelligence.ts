/**
 * Handoff Intelligence — When to act vs. when to ask
 *
 * Confucian Li — knowing when propriety demands human judgment
 *
 * Li (禮) is the Confucian concept of proper conduct: knowing what
 * is appropriate in each situation. An agent with high trust in a
 * low-risk domain can act freely. But when stakes are high or trust
 * is low, Li demands deference to human judgment.
 *
 * The rules are deliberately simple and deterministic. No ML model
 * should decide when to bypass human approval. That decision must
 * be auditable and predictable.
 *
 * Pure functions. No LLM. No database.
 */

import type { HandoffDecision } from './types.js';

/** Trust threshold above which autonomous action is possible. */
const HIGH_TRUST_THRESHOLD = 0.85;

/** Trust threshold below which human approval is always required. */
const LOW_TRUST_THRESHOLD = 0.5;

/**
 * Decide whether the agent should hand off to the human or act autonomously.
 *
 * Rules (evaluated in priority order):
 * 1. High risk → always require human judgment
 * 2. Low trust (<0.5) → always require approval
 * 3. High trust (>0.85) AND high/overloaded cognitive load → skip approval
 * 4. Everything else → require review
 *
 * @param domainTrust - Trust level for the relevant domain (0-1)
 * @param cognitiveLoad - Current human cognitive load estimate
 * @param taskRisk - Risk level of the task
 * @returns HandoffDecision with reasoning
 */
export function decideHandoff(
  domainTrust: number,
  cognitiveLoad: 'low' | 'moderate' | 'high' | 'overloaded',
  taskRisk: 'low' | 'medium' | 'high'
): HandoffDecision {
  // Rule 1: High risk always requires human judgment
  if (taskRisk === 'high') {
    return {
      shouldHandoff: true,
      reason: 'High-risk tasks always require human judgment regardless of trust level',
      humanJudgmentNeeded: true,
      confidence: 0.95,
    };
  }

  // Rule 2: Low trust always requires approval
  if (domainTrust < LOW_TRUST_THRESHOLD) {
    return {
      shouldHandoff: true,
      reason: `Trust level (${domainTrust.toFixed(2)}) is below the approval threshold (${LOW_TRUST_THRESHOLD})`,
      humanJudgmentNeeded: false,
      confidence: 0.9,
    };
  }

  // Rule 3: High trust + overloaded human → act autonomously to reduce burden
  if (domainTrust > HIGH_TRUST_THRESHOLD && (cognitiveLoad === 'high' || cognitiveLoad === 'overloaded')) {
    return {
      shouldHandoff: false,
      reason: `High trust (${domainTrust.toFixed(2)}) and human is ${cognitiveLoad}; acting autonomously to reduce burden`,
      humanJudgmentNeeded: false,
      confidence: 0.85,
    };
  }

  // Rule 4: Medium trust or low cognitive load → request review
  const loadDescription = cognitiveLoad === 'low' || cognitiveLoad === 'moderate'
    ? 'human has capacity for review'
    : 'trust not high enough for autonomous action';

  return {
    shouldHandoff: true,
    reason: `Trust level (${domainTrust.toFixed(2)}) and ${loadDescription}; requesting review`,
    humanJudgmentNeeded: false,
    confidence: 0.75,
  };
}
