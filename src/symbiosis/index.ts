/**
 * Symbiosis — Public API
 *
 * Layer 6: Human-AI Collaboration Intelligence (Aristotle's Philia).
 */

// Types
export type {
  DomainTrust,
  HandoffDecision,
  CollaborationModel,
  CollaborationInput,
  LearningInput,
  LearningMetrics,
} from './types.js';

// Trust Dynamics
export { updateDomainTrust, computeTrustFromHistory } from './trust-dynamics.js';

// Handoff Intelligence
export { decideHandoff } from './handoff-intelligence.js';

// Collaboration Rhythm
export { detectPattern } from './collaboration-rhythm.js';

// Mutual Learning
export { detectLearnings } from './mutual-learning.js';
