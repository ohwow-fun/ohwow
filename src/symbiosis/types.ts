/**
 * Symbiosis Type System — Human-AI Collaboration Intelligence
 *
 * Aristotle's Philia — partnership, not servitude
 *
 * Layer 6 of the philosophical architecture. Where the Soul (Layer 5)
 * observes the human to understand them, Symbiosis governs the
 * relationship itself: how trust evolves, when to act autonomously
 * vs. defer, and what each party teaches the other.
 *
 * Philia is Aristotle's term for the highest form of friendship:
 * one grounded in mutual benefit and shared purpose, not utility
 * or pleasure alone. The AI earns trust through consistent outcomes.
 * The human teaches through corrections. Both grow.
 */

// ============================================================================
// DOMAIN TRUST — Trust is contextual, not global
// ============================================================================

/**
 * Trust level for a specific domain of work.
 * An agent might be trusted with email drafts but not financial decisions.
 */
export interface DomainTrust {
  /** The domain of competence (e.g., 'email', 'finance', 'scheduling'). */
  domain: string;
  /** Current trust level (0-1). Starts at 0.5 (neutral). */
  trustLevel: number;
  /** Consecutive successes without failure. Resets on any failure. */
  consecutiveSuccesses: number;
  /** ISO timestamp of last failure, or null if none. */
  lastFailure: string | null;
  /** How many consecutive successes before trust auto-promotes. Default 5. */
  autoPromoteThreshold: number;
}

// ============================================================================
// HANDOFF DECISION — When to defer to human judgment
// ============================================================================

/**
 * The outcome of a handoff analysis.
 * Determines whether the agent should act or ask.
 */
export interface HandoffDecision {
  /** Whether the agent should hand off to the human. */
  shouldHandoff: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Whether this specifically requires human judgment (not just approval). */
  humanJudgmentNeeded: boolean;
  /** Confidence in this decision (0-1). */
  confidence: number;
}

// ============================================================================
// COLLABORATION MODEL — The partnership shape
// ============================================================================

/**
 * Describes the current collaboration pattern between a human and an agent.
 */
export interface CollaborationModel {
  /** The human in this partnership. */
  humanId: string;
  /** The agent in this partnership. */
  agentId: string;
  /** The detected optimal working pattern. */
  optimalPattern: 'delegation' | 'review' | 'pair' | 'autonomous';
  /** Trust levels broken down by domain. */
  trustByDomain: DomainTrust[];
  /** Things each party has learned from the other. */
  mutualLearnings: string[];
  /** Overall effectiveness of this partnership (0-1). */
  effectivenessScore: number;
  /** A natural-language recommendation for improving collaboration. */
  recommendation: string;
}

// ============================================================================
// COLLABORATION INPUT — Raw data for pattern detection
// ============================================================================

/**
 * Input data for analyzing collaboration patterns.
 * Built from completed task history.
 */
export interface CollaborationInput {
  completedTasks: Array<{
    /** Which agent performed the task. */
    agentId: string;
    /** Domain of the task. */
    domain: string;
    /** Whether the task completed successfully. */
    success: boolean;
    /** Whether the human modified the agent's output. */
    humanModified: boolean;
    /** Time from task completion to human approval (ms). */
    approvalTimeMs: number;
  }>;
}

// ============================================================================
// LEARNING METRICS — Bidirectional growth
// ============================================================================

/**
 * Input for detecting mutual learning events.
 */
export interface LearningInput {
  /** The agent's output text. */
  agentOutput: string;
  /** Whether the human modified the output. */
  humanModified: boolean;
  /** Whether the output was ultimately used. */
  outputUsed: boolean;
}

/**
 * Summary of bidirectional learning in the partnership.
 */
export interface LearningMetrics {
  /** Times the agent's output taught the human something (used without modification). */
  agentTaughtHuman: number;
  /** Times the human's corrections taught the agent (modified but still used). */
  humanTaughtAgent: number;
}
