/**
 * True Soul — Core Types
 *
 * Philosophy:
 * - Aristotle (De Anima): Soul = the form of the body. An agent's soul is not
 *   a ghost in the machine but the *shape* of its activity.
 * - Plato (Tripartite): Reason, Spirit, Appetite — every entity balances
 *   analysis, drive, and habit.
 * - Jung (Shadow): What the entity cannot see about itself. Blind spots
 *   revealed only through patterns of failure and friction.
 * - Heraclitus (Flux): The soul is always becoming. Identity is not fixed
 *   but a river of snapshots.
 */

// ── Tripartite Soul (Plato) ────────────────────────────────────────────

export interface Tripartite {
  reason: number;    // 0-1, data-driven, analytical
  spirit: number;    // 0-1, driven, ambitious, persistent
  appetite: number;  // 0-1, shortcut-seeking, habitual
  dominant: 'reason' | 'spirit' | 'appetite';
  balanced: boolean; // no faculty > 0.6 AND none < 0.2
}

// ── Shadow (Jung) ──────────────────────────────────────────────────────

export type ShadowCategory =
  | 'skill_gap'
  | 'value_mismatch'
  | 'behavioral_pattern'
  | 'overconfidence';

export interface ShadowPattern {
  description: string;
  confidence: number;
  occurrences: number;
  category: ShadowCategory;
  firstSeen: string;
}

// ── Growth Arc (Heraclitus) ────────────────────────────────────────────

export type GrowthDirection =
  | 'ascending'
  | 'plateau'
  | 'declining'
  | 'transforming';

export interface GrowthSnapshot {
  competence: number;
  autonomy: number;
  specialization: number;
  relationshipHealth: number;
  timestamp: string;
}

export interface GrowthArc {
  direction: GrowthDirection;
  snapshots: GrowthSnapshot[];
  velocity: number;
  transitions: Array<{
    from: GrowthDirection;
    to: GrowthDirection;
    timestamp: string;
    trigger: string;
  }>;
}

// ── Agent Soul (Aristotle: the form of the agent) ──────────────────────

export interface AgentSoul {
  agentId: string;
  agentName: string;
  tripartite: Tripartite;
  values: string[];
  shadow: ShadowPattern[];
  growthArc: GrowthArc;
  emergingIdentity: string;
  confidence: number;
  computedAt: string;
}

// ── Human Soul ─────────────────────────────────────────────────────────

export type LeadershipStyle =
  | 'micromanager'
  | 'delegator'
  | 'collaborator'
  | 'absent';

export interface HumanSoul {
  userId: string;
  tripartite: Tripartite;
  revealedValues: string[];
  statedValues: string[];
  valueGap: Array<{ stated: string; revealed: string; gap: string }>;
  shadow: ShadowPattern[];
  growthArc: GrowthArc;
  leadershipStyle: LeadershipStyle;
  confidence: number;
  computedAt: string;
}

// ── Relationship Soul ──────────────────────────────────────────────────

export interface RelationshipSoul {
  humanId: string;
  agentId: string;
  bondStrength: number;
  mutualAdaptation: {
    agentAdaptedTo: string[];
    humanAdaptedTo: string[];
  };
  sharedContext: string[];
  healthArc: GrowthArc;
  recommendation: string;
  computedAt: string;
}

// ── Computation Inputs ─────────────────────────────────────────────────

export interface AgentSoulInput {
  agentId: string;
  agentName: string;
  principleCount: number;
  avgPrincipleConfidence: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  taskThroughputPerDay: number;
  toolDiversity: number;
  toolReuseRate: number;
  positiveMemories: string[];
  negativeMemories: string[];
  principleTexts: string[];
  failureCategories: string[];
  successRateTrend: number[];
}

export interface HumanSoulInput {
  userId: string;
  avgReviewTimeMs: number;
  approvalRate: number;
  batchApprovalRate: number;
  rejectionReasons: string[];
  avgMessageLength: number;
  statedGoals: string[];
  founderFocus: string | null;
  delegationRate: number;
  engagementFrequency: number;
  trustEvolutionSpeed: number;
}

export interface RelationshipSoulInput {
  humanId: string;
  agentId: string;
  interactionCount: number;
  approvalRate: number;
  avgReviewTimeMs: number;
  reviewTimeTrend: number[];
  agentMemoriesForHuman: string[];
  humanRejectionReasons: string[];
  sharedTaskTypes: string[];
  uniqueTaskTypes: string[];
}
