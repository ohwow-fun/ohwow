/**
 * Mesh — Public API
 *
 * The fourth philosophical layer: Brain → Body → Work → Mesh.
 * Distributed being across multiple devices.
 */

// Types
export type {
  MeshConsciousnessItem,
  MeshBroadcastPayload,
  MeshConsciousnessResponse,
  MeshBodySnapshot,
  MeshDistributedBody,
  DeviceBrainProfile,
  BrainScoringWeights,
  MeshHeartbeat,
  MeshRole,
  FailoverEvent,
  MeshPeer,
  PeerProvider,
} from './types.js';
export { DEFAULT_BRAIN_SCORING_WEIGHTS } from './types.js';

// Mesh Noosphere (Hegel's Geist)
export { MeshNoosphere } from './mesh-noosphere.js';

// Mesh Body (Merleau-Ponty's Intercorporeality)
export { MeshBody } from './mesh-body.js';

// Mesh Router (Aristotle's Synergeia)
export { scoreBrainDimensions, inferRequiredTool } from './mesh-router.js';

// Mesh Resilience (Spinoza's Substance)
export { MeshResilience, HEARTBEAT_INTERVAL_MS } from './mesh-resilience.js';
export type { MeshCoordinatorLike } from './mesh-resilience.js';
