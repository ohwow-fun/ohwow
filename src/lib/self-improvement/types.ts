/**
 * Self-Improvement Types
 *
 * Consolidated types for the self-improvement subsystem:
 * E13 (compression), E14 (routing), E22 (skills), E23 (MCTS),
 * E24 (digital twin), E25 (self-play), E26 (principles),
 * E27 (process mining), E21 (proactive engine).
 */

// ============================================================================
// E13 — MEMORY COMPRESSION
// ============================================================================

export interface CompressionResult {
  episodicAnalyzed: number;
  compressedCreated: number;
  episodicSuperseded: number;
  compressionRatio: number;
  tokensUsed: number;
  costCents: number;
}

// ============================================================================
// E14 — THOMPSON SAMPLING ROUTING
// ============================================================================

export interface AgentScore {
  agentId: string;
  agentName: string;
  totalScore: number;
  signals: {
    capabilityMatch: number;
    historicalSuccess: number;
    workloadPenalty: number;
    costEfficiency: number;
    explorationBonus: number;
  };
  selected: boolean;
}

export interface RoutingDecision {
  selectedAgentId: string;
  scores: AgentScore[];
  reason: string;
  explorationUsed: boolean;
}

export interface TaskRoutingContext {
  title: string;
  description?: string;
  input?: string;
  taskType?: string;
}

// ============================================================================
// E22 — SKILL SYNTHESIS
// ============================================================================

export interface ToolCall {
  tool: string;
  inputSummary: string;
  success: boolean;
}

export interface MinedPattern {
  toolSequence: string[];
  support: number;
  sourceTaskIds: string[];
  avgSuccessRate: number;
}

export interface SynthesizedSkillMetadata {
  name: string;
  description: string;
  preconditions: string[];
  effects: string[];
}

export interface SynthesisResult {
  tracesAnalyzed: number;
  patternsFound: number;
  skillsCreated: number;
  duplicatesSkipped: number;
  tokensUsed: number;
  costCents: number;
}

// ============================================================================
// E23 — MCTS PLANNER
// ============================================================================

export interface CandidateAction {
  toolName: string;
  description: string;
  reasoning: string;
  suggestedInput: string;
}

export interface PlannerConfig {
  maxHaikuCalls: number;
  explorationConstant: number;
  branchingFactor: number;
  maxDepth: number;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  maxHaikuCalls: 3,
  explorationConstant: 1.414,
  branchingFactor: 3,
  maxDepth: 2,
};

export interface PlannerResult {
  selectedAction: CandidateAction;
  candidates: Array<{
    action: CandidateAction;
    score: number;
    visits: number;
  }>;
  activated: boolean;
  tokensUsed: number;
  costCents: number;
}

// ============================================================================
// E24 — DIGITAL TWIN
// ============================================================================

export interface CausalNode {
  id: string;
  name: string;
  currentValue: number;
  historicalValues: number[];
  unit: string;
}

export interface CausalEdge {
  fromId: string;
  toId: string;
  correlation: number;
  direction: 'positive' | 'negative';
  lagDays: number;
  coefficient: number;
}

export interface Intervention {
  nodeId: string;
  changeType: 'absolute' | 'percentage';
  changeValue: number;
  description: string;
}

export interface SimulationResult {
  intervention: Intervention;
  projections: Array<{
    nodeId: string;
    nodeName: string;
    currentValue: number;
    projectedValue: number;
    changePercent: number;
    confidence: number;
  }>;
  overallConfidence: number;
}

export interface CausalModelSnapshot {
  nodes: CausalNode[];
  edges: CausalEdge[];
  projections: SimulationResult[];
  confidence: number;
  createdAt: string;
}

export interface TwinBuildResult {
  metricsCount: number;
  edgesCount: number;
  projectionsCount: number;
  confidence: number;
}

// ============================================================================
// E25 — SELF-PLAY TRAINING
// ============================================================================

export interface TrainingScenario {
  title: string;
  description: string;
  expectedOutcome: string;
  sourceTaskId: string;
  variation: 'similar' | 'harder' | 'edge_case';
}

export interface PracticeResult {
  scenario: TrainingScenario;
  completed: boolean;
  output: string;
  verificationScore: number;
  toolCallCount: number;
  learningsExtracted: number;
  costCents: number;
}

export interface PracticeRunSummary {
  scenariosGenerated: number;
  sessionsRun: number;
  sessionsCompleted: number;
  totalLearnings: number;
  totalCostCents: number;
}

// ============================================================================
// E26 — PRINCIPLE DISTILLATION
// ============================================================================

export type PrincipleCategory =
  | 'tool_usage'
  | 'communication'
  | 'data_handling'
  | 'workflow'
  | 'safety'
  | 'strategy';

export interface DistillationResult {
  memoriesAnalyzed: number;
  groupsFormed: number;
  principlesCreated: number;
  duplicatesSkipped: number;
  tokensUsed: number;
  costCents: number;
}

// ============================================================================
// E27 — PROCESS MINING
// ============================================================================

export interface ProcessStep {
  toolName: string;
  agentId: string | null;
  avgDurationMs: number;
  order: number;
}

export interface WorkflowCandidate {
  toolSequence: string[];
  frequency: number;
  agentIds: string[];
  sourceTaskIds: string[];
  avgDurationMs: number;
}

export interface ProcessMiningResult {
  entriesAnalyzed: number;
  candidatesFound: number;
  processesDiscovered: number;
  duplicatesSkipped: number;
  tokensUsed: number;
  costCents: number;
}

// ============================================================================
// E21 — PROACTIVE ENGINE
// ============================================================================

export type SignalSource =
  | 'goal_shortfall'
  | 'stale_leads'
  | 'schedule_gap'
  | 'failed_pattern'
  | 'discovered_process'
  | 'idle_agent';

export interface ProactiveSignal {
  source: SignalSource;
  priority: number;
  description: string;
  suggestedTitle: string;
  suggestedDescription: string;
  suggestedAgentId?: string;
  context: Record<string, unknown>;
}

export interface ProactiveRunSummary {
  signalsEvaluated: number;
  tasksCreated: number;
  tasksSkipped: number;
  skipReasons: Record<string, number>;
}

// ============================================================================
// SHARED — LLM HELPER
// ============================================================================

/** Result from an LLM call via ModelRouter */
export interface LLMCallResult {
  success: boolean;
  content: string;
  inputTokens: number;
  outputTokens: number;
  tokensUsed: number;
  error?: string;
}

// ============================================================================
// SHARED — IMPROVEMENT CYCLE
// ============================================================================

/** Result of a full self-improvement cycle */
export interface ImprovementCycleResult {
  compression: CompressionResult | null;
  patternMining: { patternsFound: number } | null;
  skillSynthesis: SynthesisResult | null;
  processMining: ProcessMiningResult | null;
  principleDistillation: DistillationResult | null;
  signalEvaluation: { signalsFound: number } | null;
  digitalTwin: TwinBuildResult | null;
  totalTokensUsed: number;
  totalCostCents: number;
  durationMs: number;
}
