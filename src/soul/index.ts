/**
 * True Soul — Public API
 *
 * Every entity has a soul: agents, humans, and the relationships between them.
 * This module computes souls from observable behavior, never from self-report.
 */

// Core types
export type {
  Tripartite,
  ShadowCategory,
  ShadowPattern,
  GrowthDirection,
  GrowthSnapshot,
  GrowthArc,
  AgentSoul,
  LeadershipStyle,
  HumanSoul,
  RelationshipSoul,
  AgentSoulInput,
  HumanSoulInput,
  RelationshipSoulInput,
} from './types.js';

// Shadow detection
export { detectShadows } from './shadow.js';

// Growth tracking
export { computeGrowthArc, computeGrowthSnapshot } from './growth-arc.js';

// Soul computation
export { computeAgentSoul } from './agent-soul.js';
export { computeHumanSoul } from './human-soul.js';
export { computeRelationshipSoul } from './relationship-soul.js';

// Unified coordinator
export { TrueSoul } from './soul.js';
