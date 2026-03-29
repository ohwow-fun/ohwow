/**
 * Soul Type System — Deep Human Persona Awareness (Aristotle's Psyche)
 *
 * "The soul is the form of the body." — Aristotle, De Anima
 *
 * Layer 5 of the philosophical architecture. The system observes
 * human behavior over time and builds a nuanced understanding of
 * each person: their rhythms, their capacity, their communication
 * style, their trust in each agent.
 *
 * This is not surveillance. It is the same understanding a good
 * executive assistant develops after years of working with someone.
 * The agent learns to serve better, not to manipulate.
 *
 * Philosophical grounding:
 * - Aristotle (Psyche): what animates this particular person
 * - Levinas (Ethics of the Other): the human's needs make demands on the agent
 * - Heraclitus (Flux): the human is always changing, the model must adapt
 */

// ============================================================================
// CHRONO-BIOLOGY — When does this person do their best work?
// ============================================================================

/**
 * Circadian profile inferred from behavioral observation.
 * Not from a setting. From watching when actions happen.
 */
export interface ChronoBioProfile {
  /** Hours of day with highest activity (0-23). */
  peakHours: number[];
  /** Hours with lowest activity. */
  lowHours: number[];
  /** Average hour of first daily action. */
  averageFirstActionHour: number;
  /** Average hour of last daily action. */
  averageLastActionHour: number;
  /** Whether the person works weekends (>10% of activity on Sat/Sun). */
  weekendActive: boolean;
  /** Confidence in this profile (0-1). Increases with data points. */
  confidence: number;
}

// ============================================================================
// COGNITIVE LOAD — How much can this person handle right now?
// ============================================================================

/** How loaded the human is right now. */
export type CognitiveLoadLevel = 'low' | 'moderate' | 'high' | 'overloaded';

/** What the system should do given the current load. */
export type LoadRecommendation = 'add_work' | 'hold' | 'reduce' | 'critical_only';

/**
 * Real-time estimate of the human's cognitive capacity.
 * When overloaded, the system should STOP adding tasks.
 */
export interface CognitiveLoadState {
  level: CognitiveLoadLevel;
  openApprovals: number;
  openTasks: number;
  /** Decisions made in the last hour. */
  recentDecisions: number;
  /** Estimated remaining capacity (0-1). */
  estimatedCapacity: number;
  /** What the system should do. */
  recommendation: LoadRecommendation;
}

// ============================================================================
// COMMUNICATION — How does this person prefer to interact?
// ============================================================================

/** Preferred communication depth. */
export type CommunicationLength = 'brief' | 'moderate' | 'detailed';

/** How quickly this person makes decisions. */
export type DecisionStyle = 'fast' | 'deliberate' | 'cautious';

/**
 * Communication style inferred from message patterns.
 */
export interface CommunicationProfile {
  preferredLength: CommunicationLength;
  averageMessageWords: number;
  prefersBullets: boolean;
  /** Average time to respond to agent output (ms). */
  responseLatencyMs: number;
  decisionStyle: DecisionStyle;
}

// ============================================================================
// AGENT TRUST — Dynamic trust per agent (not static autonomy levels)
// ============================================================================

/** Trust trend direction. */
export type TrustTrend = 'rising' | 'stable' | 'declining';

/** Trust data for a specific agent. */
export interface AgentTrustEntry {
  trustScore: number;
  totalInteractions: number;
  approvalRate: number;
  avgTimeToApproveMs: number;
  lastInteraction: string;
  trend: TrustTrend;
}

/** Map of agent ID to trust data. */
export type AgentTrustMap = Record<string, AgentTrustEntry>;

// ============================================================================
// ENERGY & WORK INTENSITY
// ============================================================================

/** Current energy state estimate. */
export type EnergyState = 'peak' | 'normal' | 'low' | 'rest';

/** Current work intensity pattern. */
export type WorkIntensity = 'sprint' | 'steady' | 'light' | 'recovery';

// ============================================================================
// PERSONA MODEL — The complete picture
// ============================================================================

/**
 * The complete persona model for one human.
 * Built from behavioral observation over time.
 */
export interface PersonaModel {
  userId: string;
  chronoBio: ChronoBioProfile;
  cognitiveLoad: CognitiveLoadState;
  communication: CommunicationProfile;
  agentTrust: AgentTrustMap;
  energyState: EnergyState;
  workIntensity: WorkIntensity;
  lastUpdated: string;
  /** Total behavioral observations that built this model. */
  dataPoints: number;
}

// ============================================================================
// BEHAVIORAL EVENT — Raw observation input
// ============================================================================

/** Types of behavioral events the system observes. */
export type BehavioralEventType =
  | 'approval'
  | 'rejection'
  | 'message_sent'
  | 'task_created'
  | 'briefing_read'
  | 'setting_changed'
  | 'session_start'
  | 'session_end';

/**
 * A single behavioral observation.
 * These accumulate over time and feed the persona model.
 */
export interface BehavioralEvent {
  type: BehavioralEventType;
  timestamp: number;
  metadata: Record<string, unknown>;
}

// ============================================================================
// COGNITIVE LOAD INPUT — For real-time computation
// ============================================================================

/** Input for computing current cognitive load. */
export interface CognitiveLoadInput {
  openApprovals: number;
  openTasks: number;
  recentDecisionsCount: number;
}

// ============================================================================
// CHRONO-BIO INPUT — For profile computation
// ============================================================================

/** Input for computing circadian profile. */
export interface ChronoBioInput {
  /** Array of timestamps (epoch ms) of user actions. */
  actionTimestamps: number[];
}

// ============================================================================
// COMMUNICATION INPUT — For style inference
// ============================================================================

/** Input for computing communication profile. */
export interface CommunicationInput {
  /** Recent messages with word counts. */
  messages: Array<{ wordCount: number; timestamp: number }>;
  /** Approval timing data. */
  approvals: Array<{ taskCompletedAt: number; approvedAt: number }>;
  /** Briefing preference (if explicitly set). */
  briefingFormat?: 'bullets' | 'detailed' | 'digest';
}
