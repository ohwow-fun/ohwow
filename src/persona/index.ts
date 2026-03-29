/**
 * Soul — Public API
 *
 * Layer 5: Deep human persona awareness (Aristotle's Psyche).
 */

// Types
export type {
  PersonaModel,
  ChronoBioProfile,
  ChronoBioInput,
  CognitiveLoadState,
  CognitiveLoadInput,
  CognitiveLoadLevel,
  LoadRecommendation,
  CommunicationProfile,
  CommunicationInput,
  CommunicationLength,
  DecisionStyle,
  AgentTrustMap,
  AgentTrustEntry,
  TrustTrend,
  EnergyState,
  WorkIntensity,
  BehavioralEvent,
  BehavioralEventType,
} from './types.js';

// Core modules
export { computeChronoBio, estimateEnergyState } from './chrono-bio.js';
export { computeCognitiveLoad, shouldAddWork } from './cognitive-load.js';
export { computeCommunicationProfile, formatCommunicationGuidance } from './communication.js';

// Persona Observer
export { PersonaObserver } from './persona-observer.js';
export type { PersonaPersistence } from './persona-observer.js';

// Soul Coordinator
export { Soul } from './soul.js';
