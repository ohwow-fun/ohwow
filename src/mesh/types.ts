/**
 * Mesh Type System — Distributed Being (Leibniz + Hegel)
 *
 * The fourth philosophical layer: Brain → Body → Work → Mesh.
 *
 * - MeshConsciousnessItem (Hegel's Geist): thought propagating across devices
 * - MeshDistributedBody (Merleau-Ponty): shared embodiment across peers
 * - DeviceBrainProfile (Aristotle's Synergeia): experience-aware routing
 * - MeshResilience (Spinoza): self-healing through distributed substance
 */

import type { WorkspaceItem } from '../brain/types.js';
import type { UmweltDimension, Affordance, OrganHealth, BodyDomain } from '../body/types.js';
import type { WorkKind } from '../work/types.js';

// ============================================================================
// CONSCIOUSNESS PROPAGATION — Hegel's Geist
// ============================================================================

/**
 * A consciousness item prepared for mesh propagation.
 * Wraps WorkspaceItem with TTL and dedup metadata.
 */
export interface MeshConsciousnessItem {
  /** The original workspace item. */
  item: WorkspaceItem;
  /** Dedup hash: hash(originDeviceId + content + timestamp). */
  meshId: string;
  /** Which device originated this. */
  originDeviceId: string;
  /** Hop count. Discard when >= maxHops. */
  hops: number;
  /** Maximum hops (default 2). */
  maxHops: number;
  /** Absolute expiry (epoch ms). */
  expiresAt: number;
}

/** Payload for POST /api/mesh/broadcast. */
export interface MeshBroadcastPayload {
  items: MeshConsciousnessItem[];
  senderDeviceId: string;
  senderName: string;
}

/** Response from GET /api/mesh/consciousness. */
export interface MeshConsciousnessResponse {
  items: MeshConsciousnessItem[];
  deviceId: string;
  deviceName: string;
  workspaceSize: number;
  brainProfile?: DeviceBrainProfile;
  timestamp: number;
}

// ============================================================================
// DISTRIBUTED BODY — Merleau-Ponty's Intercorporeality
// ============================================================================

/** A snapshot of one peer's body state. */
export interface MeshBodySnapshot {
  deviceId: string;
  deviceName: string;
  organs: Array<{
    id: string;
    name: string;
    domain: BodyDomain;
    health: OrganHealth;
  }>;
  umwelt: UmweltDimension[];
  affordances: Affordance[];
  resources: Record<string, { used: number; total: number }>;
  capturedAt: number;
}

/** Aggregated distributed body across all mesh peers. */
export interface MeshDistributedBody {
  organs: Array<MeshBodySnapshot['organs'][0] & { sourceDeviceId: string }>;
  umwelt: Array<UmweltDimension & { sourceDeviceId: string }>;
  affordances: Array<Affordance & { sourceDeviceId: string }>;
  deviceResources: Array<{
    deviceId: string;
    deviceName: string;
    resources: Record<string, { used: number; total: number }>;
    lastSeen: number;
    stale: boolean;
  }>;
  totalModalities: number;
  totalAffordances: number;
  aggregatedAt: number;
}

// ============================================================================
// BRAIN-INFORMED ROUTING — Aristotle's Synergeia
// ============================================================================

/** Brain experience data for routing decisions. */
export interface DeviceBrainProfile {
  deviceId: string;
  predictionAccuracy: number;
  toolMastery: Record<string, { mastery: string; successRate: number; totalUses: number }>;
  workKindAffinity: Record<WorkKind, number>;
  completionRate: number;
  capturedAt: number;
}

/** Scoring weights for brain-informed routing. */
export interface BrainScoringWeights {
  toolMastery: number;
  workKindAffinity: number;
  predictionAccuracy: number;
  completionRate: number;
}

export const DEFAULT_BRAIN_SCORING_WEIGHTS: BrainScoringWeights = {
  toolMastery: 15,
  workKindAffinity: 10,
  predictionAccuracy: 5,
  completionRate: 5,
};

// ============================================================================
// RESILIENCE — Self-healing mesh
// ============================================================================

export type MeshRole = 'primary' | 'secondary' | 'worker';

/** Heartbeat sent by the primary to all peers. */
export interface MeshHeartbeat {
  deviceId: string;
  machineId: string;
  role: MeshRole;
  timestamp: number;
  ownedConnectionIds: string[];
  consciousnessDigest?: {
    itemCount: number;
    topItems: MeshConsciousnessItem[];
  };
}

/** Emitted when the primary fails and a new one is promoted. */
export interface FailoverEvent {
  failedDeviceId: string;
  failedMachineId: string;
  promotedDeviceId: string;
  promotedMachineId: string;
  transferredConnectionIds: string[];
  timestamp: number;
}

// ============================================================================
// PEER PROVIDER — Abstraction for accessing connected peers
// ============================================================================

/** Minimal peer interface for mesh modules (avoids tight coupling to DB). */
export interface MeshPeer {
  id: string;
  name: string;
  baseUrl: string;
  tunnelUrl: string | null;
  peerToken: string | null;
  status: string;
  machineId: string | null;
  deviceId?: string;
}

/** Provider that lists connected peers (implemented by PeerMonitor or DB query). */
export interface PeerProvider {
  getConnectedPeers(): MeshPeer[];
}
