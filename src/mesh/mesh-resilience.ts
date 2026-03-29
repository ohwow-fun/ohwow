/**
 * Mesh Resilience — Self-Healing (Spinoza)
 *
 * "Deus sive Natura" — The substance persists through its modes.
 *
 * The mesh heals itself when the primary device fails. Heartbeat-based
 * detection triggers automatic promotion using the same deterministic
 * election rule (lowest MAC). Connection ownership transfers automatically.
 * The organism survives the death of individual cells.
 */

import type { MeshHeartbeat, FailoverEvent, MeshRole } from './types.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Heartbeat interval (ms). Primary sends this often. */
export const HEARTBEAT_INTERVAL_MS = 10_000; // 10 seconds

/** If primary heartbeat older than this, consider it failed. */
const PRIMARY_TIMEOUT_MS = 30_000; // 30 seconds (3 missed beats)

// ============================================================================
// MESH RESILIENCE
// ============================================================================

/** Minimal mesh coordinator interface (avoids tight coupling). */
export interface MeshCoordinatorLike {
  isPrimary: boolean;
  primaryMachineId: string | null;
  getOwnedConnections(machineId: string): string[];
}

export class MeshResilience {
  private coordinator: MeshCoordinatorLike;
  private localMachineId: string;
  private localDeviceId: string;
  private heartbeats: Map<string, { timestamp: number; ownedConnectionIds: string[] }> = new Map();

  constructor(
    coordinator: MeshCoordinatorLike,
    localMachineId: string,
    localDeviceId: string,
  ) {
    this.coordinator = coordinator;
    this.localMachineId = localMachineId;
    this.localDeviceId = localDeviceId;
  }

  // --------------------------------------------------------------------------
  // HEARTBEAT RECORDING
  // --------------------------------------------------------------------------

  /** Record a heartbeat from a peer (or self). */
  recordHeartbeat(heartbeat: MeshHeartbeat): void {
    this.heartbeats.set(heartbeat.machineId, {
      timestamp: heartbeat.timestamp,
      ownedConnectionIds: heartbeat.ownedConnectionIds,
    });
  }

  // --------------------------------------------------------------------------
  // FAILURE DETECTION
  // --------------------------------------------------------------------------

  /**
   * Check if the primary device is healthy.
   * Returns a FailoverEvent if the primary has failed and this device
   * should promote, or null if everything is fine.
   */
  checkPrimaryHealth(
    connectedMachineIds: string[],
  ): FailoverEvent | null {
    // If we ARE the primary, no failover needed
    if (this.coordinator.isPrimary) return null;

    const primaryId = this.coordinator.primaryMachineId;
    if (!primaryId) return null;

    // Check if we've received a heartbeat from the primary recently
    const primaryHeartbeat = this.heartbeats.get(primaryId);
    const now = Date.now();

    if (primaryHeartbeat && (now - primaryHeartbeat.timestamp) < PRIMARY_TIMEOUT_MS) {
      // Primary is healthy
      return null;
    }

    // Primary is unhealthy. Should WE promote?
    // Use deterministic election: lowest MAC among remaining healthy peers
    const healthyMachineIds = connectedMachineIds.filter(id => {
      if (id === primaryId) return false; // exclude failed primary
      const hb = this.heartbeats.get(id);
      return hb && (now - hb.timestamp) < PRIMARY_TIMEOUT_MS;
    });

    // Include ourselves
    healthyMachineIds.push(this.localMachineId);
    healthyMachineIds.sort();

    const shouldPromote = healthyMachineIds[0] === this.localMachineId;

    if (!shouldPromote) return null;

    // We are the new primary!
    const failedConnectionIds = primaryHeartbeat?.ownedConnectionIds ?? [];

    logger.warn(
      { failedPrimary: primaryId, promoted: this.localMachineId, connections: failedConnectionIds.length },
      '[MeshResilience] Primary failure detected. Promoting self.',
    );

    return {
      failedDeviceId: primaryId, // using machineId as deviceId for simplicity
      failedMachineId: primaryId,
      promotedDeviceId: this.localDeviceId,
      promotedMachineId: this.localMachineId,
      transferredConnectionIds: failedConnectionIds,
      timestamp: now,
    };
  }

  // --------------------------------------------------------------------------
  // HEARTBEAT SENDING
  // --------------------------------------------------------------------------

  /** Build a heartbeat to send to peers. */
  buildHeartbeat(): MeshHeartbeat {
    return {
      deviceId: this.localDeviceId,
      machineId: this.localMachineId,
      role: this.coordinator.isPrimary ? 'primary' : 'worker',
      timestamp: Date.now(),
      ownedConnectionIds: this.coordinator.getOwnedConnections(this.localMachineId),
    };
  }

  /** Get the health status of all tracked peers. */
  getPeerHealthStatus(): Array<{ machineId: string; healthy: boolean; lastHeartbeat: number }> {
    const now = Date.now();
    const result: Array<{ machineId: string; healthy: boolean; lastHeartbeat: number }> = [];

    for (const [machineId, hb] of this.heartbeats) {
      result.push({
        machineId,
        healthy: (now - hb.timestamp) < PRIMARY_TIMEOUT_MS,
        lastHeartbeat: hb.timestamp,
      });
    }

    return result;
  }
}
