/**
 * Work Ontology Type System — Purposeful Action (Aristotle)
 *
 * The third philosophical layer: Brain (cognition) → Body (embodiment) → Work (purpose).
 * Every type maps to Aristotelian concepts:
 *
 * - WorkKind (theoria/poiesis/praxis): three modes of human activity
 * - Telos: purpose, the "final cause" of action
 * - Ergon: proper function, what counts as good work
 * - Kairos: the right moment for action
 * - Phronesis: practical wisdom, knowing what to do in context
 * - Dynamis/Energeia: potential vs actual capacity
 * - Eudaimonia: flourishing, the holistic health of the whole system
 * - Synergeia: working together, the whole greater than parts
 */

// ============================================================================
// WORK KIND — Three modes of activity (Aristotle, Nicomachean Ethics)
// ============================================================================

/**
 * Aristotle's three modes of human activity:
 * - theoria: contemplation, understanding for its own sake (research, analysis)
 * - poiesis: production, making artifacts (content, code, designs)
 * - praxis: action, purposeful change in the world (sales, outreach, hiring)
 */
export type WorkKind = 'theoria' | 'poiesis' | 'praxis';

// ============================================================================
// TELOS — Purpose (Aristotle, Metaphysics)
// ============================================================================

/** How well a task aligns with the workspace's purpose. */
export type TelosAlignment = 'critical' | 'high' | 'moderate' | 'tangential' | 'misaligned';

/** A derived mandate: what the workspace MUST do. */
export interface WorkImperative {
  id: string;
  label: string;
  priority: number; // 1-10, higher = more important
  source: 'growth_stage' | 'growth_goal' | 'founder_focus' | 'business_type';
  workKind: WorkKind;
}

/** The workspace's derived purpose profile. */
export interface TelosProfile {
  growthStageId: number;
  growthStageName: string;
  focusAreas: string[];
  workImperatives: WorkImperative[];
  businessType: string;
  founderFocus: string | null;
}

/** Input for telos derivation. */
export interface TelosInput {
  growthStageId: number;
  growthStageName: string;
  focusAreas: string[];
  growthGoals: string[];
  founderFocus: string | null;
  businessType: string;
}

// ============================================================================
// ERGON — Proper Function (Aristotle, Nicomachean Ethics)
// ============================================================================

/** Success criterion for a piece of work. */
export interface SuccessCriterion {
  metric: string;
  threshold: number;
}

/** How a task or action is classified by its nature. */
export interface ErgonClassification {
  kind: WorkKind;
  confidence: number; // 0-1
  successCriteria: SuccessCriterion[];
  evaluationApproach: string;
}

/** Input for work classification. */
export interface ErgonInput {
  taskTitle: string;
  taskDescription?: string;
  toolNames?: string[];
}

// ============================================================================
// KAIROS — Right Moment (Greek concept)
// ============================================================================

/** How urgent the temporal opportunity is. */
export type KairosUrgency = 'now_or_never' | 'time_sensitive' | 'optimal_window' | 'anytime';

/** A proactive signal enriched with temporal awareness. */
export interface KairosSignal {
  source: string;
  priority: number;
  description: string;
  context: Record<string, unknown>;
  urgency: KairosUrgency;
  windowOpenAt: string | null;
  windowCloseAt: string | null;
  /** How fast the opportunity degrades (higher = more urgent). */
  decayRate: number;
}

/** Minimal goal interface for kairos evaluation. */
export interface KairosGoal {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
  currentValue: number;
  targetValue: number | null;
}

// ============================================================================
// PHRONESIS — Practical Wisdom (Aristotle, Nicomachean Ethics)
// ============================================================================

/** A prioritization rule for a growth stage. */
export interface PriorityRule {
  condition: string;
  recommendation: string;
  weight: number;
}

/** Growth-stage-aware work allocation recommendation. */
export interface PhronesisRecommendation {
  stageId: number;
  stageName: string;
  allocation: Record<WorkKind, number>; // percentages summing to 100
  priorityRules: PriorityRule[];
  antiPatterns: string[];
}

// ============================================================================
// DYNAMIS — Potential & Capacity (Aristotle, Metaphysics)
// ============================================================================

/** Capacity state of a team member or agent. */
export type CapacityState = 'overloaded' | 'stretched' | 'balanced' | 'underutilized' | 'idle';

/** Growth trajectory direction. */
export type GrowthTrajectory = 'improving' | 'stable' | 'declining';

/** Capacity profile for a team member or agent. */
export interface DynamisProfile {
  entityId: string;
  entityName: string;
  entityType: 'agent' | 'human';
  skills: string[];
  capacity: number; // 0-1 max capacity
  currentUtilization: number; // 0-1 current load
  state: CapacityState;
  potentialGap: number; // capacity - utilization (positive = room to grow)
  growthTrajectory: GrowthTrajectory;
}

/** Input for dynamis computation. */
export interface DynamisInput {
  agents: Array<{
    id: string;
    name: string;
    skills: string[];
    totalTasks: number;
    completedTasks: number;
    recentTaskCount: number; // last 7 days
    previousTaskCount: number; // prior 7 days
  }>;
  teamMembers: Array<{
    id: string;
    name: string;
    skills: string[];
    capacity: number;
    recentTaskCount: number;
  }>;
}

// ============================================================================
// SYNERGEIA — Working Together (Aristotle, Politics)
// ============================================================================

/** How a human and agent collaborate. */
export type CollaborationPattern = 'delegation' | 'review' | 'iteration' | 'autonomous' | 'pair';

/** Collaboration profile for a human-agent pair. */
export interface SynergeiaProfile {
  humanId: string;
  humanName: string;
  agentId: string;
  agentName: string;
  pattern: CollaborationPattern;
  effectivenessScore: number; // 0-1
  avgReviewTimeMs: number;
  agentAccuracyWithHuman: number; // 0-1 (fraction without revision)
  totalCollaborations: number;
  recommendation: string;
}

/** Input for synergeia computation. */
export interface SynergeiaInput {
  completedTasks: Array<{
    agentId: string;
    agentName: string;
    pointPersonId: string | null;
    pointPersonName: string | null;
    truthScore: number | null;
    completedAt: string;
    approvedAt: string | null;
    rejectedAt: string | null;
  }>;
}

// ============================================================================
// EUDAIMONIA — Flourishing (Aristotle, Nicomachean Ethics)
// ============================================================================

/** A dimension of the flourishing score. */
export interface EudaimoniaDimension {
  name: string;
  score: number; // 0-1
  weight: number;
  trend: 'up' | 'flat' | 'down';
}

/** Health status of the workspace. */
export type EudaimoniaStatus = 'flourishing' | 'growing' | 'stable' | 'struggling' | 'critical';

/** Composite flourishing score. */
export interface EudaimoniaScore {
  overall: number; // 0-100
  dimensions: EudaimoniaDimension[];
  healthStatus: EudaimoniaStatus;
  computedAt: string;
}

/** Input for eudaimonia computation. */
export interface EudaimoniaInput {
  goalsOnTrack: number; // fraction 0-1
  agentSuccessRate: number; // fraction 0-1
  agentCostNormalized: number; // fraction 0-1 (0 = free, 1 = max budget)
  teamBalancedFraction: number; // fraction of team in balanced/improving state
  businessTrend: 'up' | 'flat' | 'down';
  systemHealthScore: number; // 0-1
  purposeAlignmentScore: number; // fraction of recent tasks aligned with telos
}

// ============================================================================
// WORK ONTOLOGY SNAPSHOT — Complete state for API/dashboard
// ============================================================================

/** The complete work ontology state, JSON-serializable. */
export interface WorkOntologySnapshot {
  telos: TelosProfile;
  phronesis: PhronesisRecommendation;
  eudaimonia: EudaimoniaScore;
  dynamis: DynamisProfile[];
  synergeia: SynergeiaProfile[];
  computedAt: string;
}
