/**
 * Brain — Public API
 *
 * The philosophical cognitive architecture for the ohwow local runtime.
 *
 * Phase 1: Foundation (types, experience stream, self-model)
 * Phase 2: Predictive engine (Friston)
 * Phase 3: Intentionality + temporal frame (Husserl + Heidegger)
 * Phase 4: Tool embodiment (Merleau-Ponty)
 * Phase 5: Dialectic + global workspace + brain coordinator (Hegel + Baars)
 * Phase 6: Live self-improvement connection (Buddhist dependent origination)
 */

// Phase 1: Foundation
export type {
  // Core types
  Stimulus,
  StimulusSource,
  StimulusType,
  Experience,
  ExperienceType,
  Prediction,
  PredictionError,
  TemporalFrame,
  EnrichedIntent,
  ContextHorizon,
  SelfModel,
  ToolProfile,
  ToolMastery,
  Perception,
  Plan,
  PlannedAction,
  BrainEvent,
  InternalBrainEvent,
  WorkspaceItem,
  WorkspaceFilter,
} from './types.js';

export { ExperienceStream } from './experience-stream.js';
export type { ExperienceFilter, ExperienceListener, ExperiencePersistence } from './experience-stream.js';

export { SelfModelBuilder } from './self-model.js';
export type { SelfModelDeps } from './self-model.js';

// Phase 2: Predictive Engine (Friston)
export { PredictiveEngine } from './predictive-engine.js';

// Phase 3: Intentionality (Husserl) + Temporal Frame (Heidegger)
export { enrichIntent } from './intentionality.js';
export { TemporalFrameBuilder, buildTemporalReflection } from './temporal-frame.js';

// Phase 4: Tool Embodiment (Merleau-Ponty)
export { applyToolEmbodiment, estimateEmbodimentSavings, getCompactDescription } from './tool-embodiment.js';

// Phase 5: Dialectic (Hegel) + Global Workspace (Baars) + Brain Coordinator
export { dialecticCheck, formatDialecticWarning } from './dialectic.js';
export type { DialecticResult } from './dialectic.js';
export { GlobalWorkspace } from './global-workspace.js';
export { Brain } from './brain.js';
export type { BrainDependencies } from './brain.js';
