/**
 * Brain Type System
 *
 * Core types for the philosophical cognitive architecture.
 * Each type maps to a foundational concept:
 *
 * - Stimulus (Empiricism): raw sensory input from the world
 * - Perception (Husserl): enriched stimulus with intentional horizons
 * - TemporalFrame (Heidegger): retention/impression/protention
 * - SelfModel (Kant): transcendental apperception — self-awareness
 * - Plan (Hegel): thesis with optional dialectic counter-argument
 * - Experience (Whitehead): atomic unit of process ontology
 * - BrainEvent: superset of OrchestratorEvent for cognitive events
 */

import type { ClassifiedIntent, OrchestratorEvent } from '../orchestrator/orchestrator-types.js';
import type { IntentSection } from '../orchestrator/tool-definitions.js';
import type { ToolResult } from '../orchestrator/local-tool-types.js';
import type { RagMemory } from '../lib/rag/retrieval.js';
import type { TranscriptionSegment } from '../voice/types.js';

// ============================================================================
// STIMULUS — Raw input (Empiricism)
// ============================================================================

/** The source of a stimulus entering the brain. */
export type StimulusSource =
  | 'orchestrator'      // user message via TUI/API
  | 'engine'            // agent task execution
  | 'self_improvement'  // pattern miner, signal evaluator, etc.
  | 'cron'              // scheduled triggers
  | 'channel'           // Telegram, WhatsApp, etc.
  | 'peer'              // A2A / peer workspace
  | 'voice';            // voice/audio input (auditory modality)

/** Classification of what kind of input this is. */
export type StimulusType =
  | 'user_message'
  | 'tool_result'
  | 'agent_event'
  | 'timer'
  | 'signal'
  | 'memory_recall'
  | 'auditory_input';   // speech/audio stimulus (voice modality)

/**
 * A Stimulus is anything that enters the brain from the outside world.
 * In empiricist philosophy, all knowledge begins with sensory experience.
 * The brain transforms raw stimuli into structured perceptions.
 */
export interface Stimulus {
  type: StimulusType;
  content: unknown;
  source: StimulusSource;
  timestamp: number;
  /** Optional trace ID for correlating with orchestrator/engine execution. */
  traceId?: string;
  /** Voice-specific metadata (only present for auditory stimuli). */
  voiceContext?: {
    sttConfidence: number;
    sttProvider: string;
    language?: string;
    durationMs: number;
    segments?: TranscriptionSegment[];
  };
}

// ============================================================================
// EXPERIENCE — Atomic process event (Whitehead)
// ============================================================================

/**
 * Categories of experience the brain can have.
 * Each maps to Whitehead's "actual occasions of experience."
 */
export type ExperienceType =
  | 'stimulus_received'
  | 'tool_predicted'
  | 'tool_executed'
  | 'prediction_error'
  | 'stagnation_detected'
  | 'plan_generated'
  | 'dialectic_applied'
  | 'memory_extracted'
  | 'pattern_discovered'
  | 'insight_broadcast'
  // Body experience types (Embodiment Layer)
  | 'body_sensation'          // Raw sensor data or digital state change
  | 'body_reflex'             // A reflex was triggered (bypassed brain)
  | 'body_health_change'      // An organ's health status changed
  | 'body_affordance_change'  // Available actions changed
  // Voice experience types (Auditory Modality)
  | 'voice_session_started'   // Voice session opened (mic + speaker active)
  | 'voice_session_ended'     // Voice session closed
  | 'voice_processed';        // Complete STT → orchestrator → TTS cycle

/**
 * An Experience is the atomic unit of the brain's process ontology.
 * Everything that happens is an experience. The brain is not a thing;
 * it is a stream of experiences (Whitehead: "the process is the reality").
 */
export interface Experience {
  id: string;
  timestamp: number;
  type: ExperienceType;
  data: unknown;
  /** What caused this experience — for causal chains. */
  causalPredecessor?: string;
  /** The source system that generated this experience. */
  source: StimulusSource;
}

// ============================================================================
// PREDICTION — Expected outcome (Friston's Free Energy)
// ============================================================================

/**
 * A Prediction is the brain's expectation about what will happen.
 * The Free Energy Principle (Friston): organisms minimize surprise
 * by building generative models and acting to confirm predictions.
 */
export interface Prediction {
  /** What is being predicted (tool name, outcome type, etc.) */
  target: string;
  /** Expected outcome. */
  expectedResult: 'success' | 'failure' | 'partial';
  /** Confidence in this prediction (0-1). */
  confidence: number;
  /** Reasoning for the prediction. */
  basis: string;
  /** Suggested alternative if prediction is failure. */
  suggestedAlternative?: string;
}

/**
 * When reality doesn't match expectation, we get a PredictionError.
 * These are the brain's primary learning signal.
 */
export interface PredictionError {
  prediction: Prediction;
  actualResult: 'success' | 'failure' | 'partial';
  /** Magnitude of the error (0 = correct, 1 = maximally wrong). */
  delta: number;
  /** What the brain should learn from this error. */
  lesson: string;
  timestamp: number;
}

// ============================================================================
// TEMPORAL FRAME — Time consciousness (Heidegger)
// ============================================================================

/**
 * Heidegger's analysis of Dasein's temporality:
 * - Retention: the just-past that still shapes the present
 * - Primal Impression: the living now
 * - Protention: the anticipated future that draws us forward
 *
 * The brain doesn't just have "history." It has temporal consciousness:
 * the past is retained as context, the future is anticipated as prediction.
 */
export interface TemporalFrame {
  /** Recent experiences still shaping current cognition. */
  retention: Experience[];
  /** The current stimulus being processed. */
  impression: Stimulus;
  /** Anticipated next experiences based on patterns. */
  protention: Prediction[];
  /** Where past anticipations were wrong — the primary learning signal. */
  predictionErrors: PredictionError[];
}

// ============================================================================
// ENRICHED INTENT — Intentionality with horizons (Husserl)
// ============================================================================

/**
 * Husserl's phenomenological insight: consciousness is always
 * consciousness OF something. Every mental act has:
 * - Noema: what is intended (the classified intent)
 * - Noesis: how it is intended (the mode, confidence)
 * - Horizon: the implicit background expectations
 *
 * The horizon is what makes this more than regex pattern matching.
 * When the user says "set up email automation," the horizon includes
 * the expectation that automation tools will be needed next,
 * that the user probably has an email service configured, etc.
 */
export interface ContextHorizon {
  /** What action the user will most likely take next. */
  expectedNextAction: string | null;
  /** Context that is implied but not explicitly stated. */
  impliedContext: string[];
  /** What the brain is NOT sure about — potential clarification points. */
  uncertainties: string[];
  /** Intent sections that should be pre-warmed for the next turn. */
  preWarmSections: IntentSection[];
}

/**
 * EnrichedIntent extends the regex-based ClassifiedIntent with
 * phenomenological depth. The base classification is the noema;
 * the horizon is the implicit expectation field around it.
 */
export interface EnrichedIntent extends ClassifiedIntent {
  /** The phenomenological horizon — implicit expectations. */
  horizon: ContextHorizon;
  /** How confident the brain is in this classification (0-1). */
  confidence: number;
}

// ============================================================================
// SELF-MODEL — Transcendental apperception (Kant)
// ============================================================================

/**
 * Tool mastery levels, inspired by Merleau-Ponty's embodied cognition.
 * A "mastered" tool is "ready-to-hand" (Heidegger): transparent,
 * an extension of the agent's body. A "novice" tool is "present-at-hand":
 * an object of conscious attention, requiring careful description.
 */
export type ToolMastery = 'novice' | 'familiar' | 'mastered';

/**
 * Profile of the brain's relationship with a specific tool.
 * Embodiment means the tool is not external — it's part of the agent.
 */
export interface ToolProfile {
  name: string;
  totalUses: number;
  successRate: number;
  avgLatencyMs: number;
  mastery: ToolMastery;
  /** Tool sequence patterns: "after this tool, usually use..." */
  contextualPatterns: Map<string, number>;
  /** Compressed description for mastered tools (saves tokens). */
  compactDescription?: string;
}

/**
 * Kant's "transcendental unity of apperception": the "I think" that
 * accompanies all representations. The brain must know itself —
 * its capabilities, limitations, current state, and recent performance.
 *
 * This self-model is not vanity. It's practical: a 4B-parameter model
 * should plan differently than a 70B model. An overloaded system
 * should prioritize differently than an idle one.
 */
export interface SelfModel {
  /** Number of tasks currently in execution. */
  currentLoad: number;
  /** Remaining context window tokens available. */
  tokenBudgetRemaining: number;
  /** What the active model can do (tool calling, vision, etc.). */
  modelCapabilities: string[];
  /** Active model identifier. */
  activeModel: string;
  /** Rolling confidence based on recent prediction accuracy. */
  confidence: number;
  /** Known limitations right now ("no browser", "Ollama-only", etc.). */
  limitations: string[];
  /** Per-tool proficiency profiles (Merleau-Ponty). */
  toolProficiency: Map<string, ToolProfile>;
  /** Aggregate recent performance metrics. */
  recentPerformance: {
    completionRate: number;
    avgStagnationRate: number;
    avgCostPerTask: number;
  };
  /** The body's proprioceptive state, if embodiment layer is active. */
  bodyState?: import('../body/types.js').Proprioception;
}

// ============================================================================
// PERCEPTION — Enriched stimulus (Husserl's noematic structure)
// ============================================================================

/**
 * A Perception is a fully-enriched stimulus: raw input + intent +
 * memories + temporal context + self-awareness. This is what the brain
 * "sees" after processing — the noematic whole, not the raw data.
 */
export interface Perception {
  /** The raw stimulus that triggered this perception. */
  stimulus: Stimulus;
  /** Enriched intent with horizons. */
  intent: EnrichedIntent;
  /** Relevant memories retrieved for this context. */
  relevantMemories: RagMemory[];
  /** The brain's temporal awareness: past, present, future. */
  temporalContext: TemporalFrame;
  /** The brain's self-awareness at this moment. */
  selfState: SelfModel;
  /** The phenomenological horizon of expectations. */
  horizon: ContextHorizon;
  /** Work Ontology context, when available (Aristotle). */
  workContext?: {
    telos: import('../work/types.js').TelosProfile;
    phronesis: import('../work/types.js').PhronesisRecommendation;
    workKind: import('../work/types.js').WorkKind;
  };
  /** Human persona context, when available (Aristotle's Psyche). */
  humanContext?: import('../persona/types.js').PersonaModel;
  /** Agent soul: identity, values, shadow, growth (Plato + Jung). */
  agentSoul?: import('../soul/types.js').AgentSoul;
  /** Human soul: values, shadow, leadership, growth (Plato + Jung). */
  humanSoul?: import('../soul/types.js').HumanSoul;
  /** Relationship soul: the bond between this human-agent pair. */
  relationshipSoul?: import('../soul/types.js').RelationshipSoul;
}

// ============================================================================
// PLAN — Deliberated course of action (Hegel's dialectic)
// ============================================================================

/**
 * A planned action that the brain intends to take.
 */
export interface PlannedAction {
  /** Tool to invoke. */
  toolName: string;
  /** Why this action (the brain's reasoning). */
  reasoning: string;
  /** Expected input shape. */
  suggestedInput: string;
  /** Predicted outcome. */
  prediction: Prediction;
}

/**
 * Hegel's dialectic: every thesis generates its antithesis.
 * A Plan is the thesis. The counterArgument is the antithesis.
 * The brain synthesizes them into a stronger approach.
 *
 * For simple plans (1-2 steps), no dialectic is needed.
 * For complex plans (3+), the counter-argument catches errors
 * before expensive multi-step execution begins.
 */
export interface Plan {
  /** The intended actions. */
  actions: PlannedAction[];
  /** Overall prediction for the plan. */
  prediction: Prediction;
  /** Hegelian antithesis: what could go wrong? */
  counterArgument?: string;
  /** Overall confidence in this plan (0-1). */
  confidence: number;
}

// ============================================================================
// BRAIN EVENTS — Extended orchestrator events
// ============================================================================

/** Internal brain events that supplement OrchestratorEvent. */
export type InternalBrainEvent =
  | { type: 'brain_perception'; data: { intent: string; confidence: number; horizon: ContextHorizon } }
  | { type: 'brain_prediction'; data: { target: string; confidence: number; expected: string } }
  | { type: 'brain_prediction_error'; data: { target: string; delta: number; lesson: string } }
  | { type: 'brain_dialectic'; data: { counterArgument: string; synthesized: boolean } }
  | { type: 'brain_workspace_broadcast'; data: { source: string; insightType: string; content: string } };

/**
 * BrainEvent is the union of standard orchestrator events and
 * internal brain events. The orchestrator yields these to the TUI.
 */
export type BrainEvent = OrchestratorEvent | InternalBrainEvent;

// ============================================================================
// GLOBAL WORKSPACE — Consciousness bus (Baars)
// ============================================================================

/**
 * An item broadcast to the Global Workspace (Baars' Global Workspace Theory).
 * Specialist processors (agents, tools, self-improvement modules)
 * broadcast discoveries. The brain's attention filter selects what
 * enters "conscious" processing.
 */
export interface WorkspaceItem {
  /** Who published this. */
  source: string;
  /** Classification of the insight. */
  type: 'discovery' | 'failure' | 'skill' | 'pattern' | 'warning' | 'signal';
  /** Human-readable content. */
  content: string;
  /** Salience score (0-1). Decays over time. Higher = more attention-worthy. */
  salience: number;
  /** When this was broadcast. */
  timestamp: number;
  /** Optional metadata for structured data. */
  metadata?: Record<string, unknown>;
}

/** Filter for subscribing to workspace broadcasts. */
export interface WorkspaceFilter {
  /** Only receive items from these sources. */
  sources?: string[];
  /** Only receive items of these types. */
  types?: WorkspaceItem['type'][];
  /** Minimum salience threshold. */
  minSalience?: number;
}
