/**
 * Mesh Coordinator
 * Deterministic leader election for the free-tier local mesh.
 * The device with the lowest machine_id (MAC address) is the primary.
 * All peers independently compute the same result (no consensus protocol needed).
 */

import { logger } from '../lib/logger.js';

interface MeshPeer {
  id: string;
  name: string;
  machineId: string;
  status: string;
  ownedConnectionIds?: string[];
}

export class MeshCoordinator {
  private myMachineId: string;
  private peers: MeshPeer[] = [];
  /** Maps machineId → owned connectionIds */
  private ownershipMap = new Map<string, string[]>();

  constructor(machineId: string) {
    this.myMachineId = machineId;
  }

  /**
   * Update the known peer list.
   */
  updatePeers(peers: MeshPeer[]): void {
    this.peers = peers.filter((p) => p.status === 'connected');
    // Update ownership from peer data
    for (const peer of this.peers) {
      if (peer.ownedConnectionIds && peer.ownedConnectionIds.length > 0) {
        this.ownershipMap.set(peer.machineId, peer.ownedConnectionIds);
      }
    }
  }

  /**
   * Register which connections a device owns.
   */
  registerOwnedConnections(machineId: string, connectionIds: string[]): void {
    this.ownershipMap.set(machineId, connectionIds);
  }

  /**
   * Get all connection IDs owned by a specific device.
   */
  getOwnedConnections(machineId: string): string[] {
    return this.ownershipMap.get(machineId) || [];
  }

  /**
   * Reverse lookup: find which device owns a specific connection.
   */
  getConnectionOwner(connectionId: string): string | null {
    for (const [machineId, ids] of this.ownershipMap) {
      if (ids.includes(connectionId)) return machineId;
    }
    return null;
  }

  /**
   * Whether this device is the primary (coordinator) in the mesh.
   * Deterministic: lowest MAC address wins.
   */
  get isPrimary(): boolean {
    const connectedIds = [this.myMachineId, ...this.peers.map((p) => p.machineId)].filter(Boolean);
    if (connectedIds.length === 0) return true; // solo device
    connectedIds.sort();
    return connectedIds[0] === this.myMachineId;
  }

  /**
   * Get the machine ID of the current primary.
   */
  get primaryMachineId(): string {
    const connectedIds = [this.myMachineId, ...this.peers.map((p) => p.machineId)].filter(Boolean);
    if (connectedIds.length === 0) return this.myMachineId;
    connectedIds.sort();
    return connectedIds[0];
  }

  /**
   * Get the primary peer (or null if we are primary).
   */
  get primaryPeer(): MeshPeer | null {
    if (this.isPrimary) return null;
    return this.peers.find((p) => p.machineId === this.primaryMachineId) || null;
  }

  /**
   * Total devices in the mesh (including self).
   */
  get deviceCount(): number {
    return 1 + this.peers.length;
  }

  /**
   * Log the current mesh state.
   */
  logState(): void {
    const role = this.isPrimary ? 'primary' : 'worker';
    logger.info(
      `[MeshCoordinator] Mesh: ${this.deviceCount} devices, role: ${role}, primary: ${this.primaryMachineId}`
    );
  }
}
