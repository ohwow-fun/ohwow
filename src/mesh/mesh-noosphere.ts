/**
 * Mesh Noosphere — Distributed Consciousness (Hegel's Geist)
 *
 * "Spirit is the ethical life of a people insofar as it is the
 * immediate truth." — Hegel, Phenomenology of Spirit
 *
 * The MeshNoosphere extends the local GlobalWorkspace across the
 * peer mesh. When a high-salience discovery happens on one device,
 * it propagates to all peers. Each device reflects the collective
 * consciousness without containing it fully (Leibniz's monadology).
 *
 * Protocol:
 * - Push-primary: on local broadcast with salience >= 0.5, push to peers
 * - Pull-fallback: during health checks, pull missed items from peers
 * - No re-propagation: originator fans out, receivers don't re-broadcast
 * - Dedup by meshId (LRU set of 1000)
 * - TTL: 5 minutes (consciousness is ephemeral)
 * - Max hops: 2 (sufficient for ~5 device meshes)
 */

import crypto from 'crypto';
import type { GlobalWorkspace } from '../brain/global-workspace.js';
import type { WorkspaceItem } from '../brain/types.js';
import type {
  MeshConsciousnessItem,
  MeshConsciousnessResponse,
  MeshBroadcastPayload,
  MeshPeer,
  PeerProvider,
} from './types.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Minimum salience to propagate across the mesh. */
const PROPAGATION_SALIENCE_THRESHOLD = 0.5;

/** TTL for mesh consciousness items (ms). */
const CONSCIOUSNESS_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum hops before discarding. */
const MAX_HOPS = 2;

/** Maximum seen items for dedup (LRU eviction). */
const MAX_SEEN_SET_SIZE = 1000;

/** Maximum items to include in a consciousness snapshot. */
const SNAPSHOT_LIMIT = 20;

// ============================================================================
// MESH NOOSPHERE
// ============================================================================

export class MeshNoosphere {
  private workspace: GlobalWorkspace;
  private peers: PeerProvider;
  private localDeviceId: string;
  private localDeviceName: string;
  private seenMeshIds: Set<string> = new Set();
  private seenOrder: string[] = []; // for LRU eviction
  private unsubscribe: (() => void) | null = null;
  private recentMeshItems: MeshConsciousnessItem[] = [];

  constructor(
    workspace: GlobalWorkspace,
    peers: PeerProvider,
    localDeviceId: string,
    localDeviceName: string = 'device',
  ) {
    this.workspace = workspace;
    this.peers = peers;
    this.localDeviceId = localDeviceId;
    this.localDeviceName = localDeviceName;
  }

  // --------------------------------------------------------------------------
  // LIFECYCLE
  // --------------------------------------------------------------------------

  /** Start listening to local workspace and propagating to peers. */
  start(): void {
    this.unsubscribe = this.workspace.subscribe(
      { minSalience: PROPAGATION_SALIENCE_THRESHOLD },
      (item) => this.onLocalBroadcast(item),
    );
    logger.info({ deviceId: this.localDeviceId }, '[MeshNoosphere] Started consciousness propagation');
  }

  /** Stop propagation. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // --------------------------------------------------------------------------
  // PUSH — Propagate local discoveries to peers
  // --------------------------------------------------------------------------

  private onLocalBroadcast(item: WorkspaceItem): void {
    // Don't re-propagate items that came from the mesh
    if (item.source.startsWith('mesh:')) return;

    const meshItem = this.wrapItem(item);

    // Track for snapshot
    this.recentMeshItems.push(meshItem);
    if (this.recentMeshItems.length > SNAPSHOT_LIMIT * 2) {
      this.recentMeshItems = this.recentMeshItems.slice(-SNAPSHOT_LIMIT);
    }

    // Push to all connected peers (fire-and-forget)
    const peers = this.peers.getConnectedPeers();
    for (const peer of peers) {
      this.pushToPeer(peer, [meshItem]).catch(() => {
        // Non-fatal: peer may be temporarily unreachable
      });
    }
  }

  private async pushToPeer(peer: MeshPeer, items: MeshConsciousnessItem[]): Promise<void> {
    const url = peer.tunnelUrl || peer.baseUrl;
    if (!url) return;

    const payload: MeshBroadcastPayload = {
      items,
      senderDeviceId: this.localDeviceId,
      senderName: this.localDeviceName,
    };

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (peer.peerToken) headers['X-Peer-Token'] = peer.peerToken;

      await fetch(`${url}/api/mesh/broadcast`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Non-fatal
    }
  }

  // --------------------------------------------------------------------------
  // RECEIVE — Inject items from a peer into local workspace
  // --------------------------------------------------------------------------

  /** Handle POST /api/mesh/broadcast from a peer. */
  injectFromPeer(payload: MeshBroadcastPayload): { accepted: number; rejected: number } {
    let accepted = 0;
    let rejected = 0;

    for (const meshItem of payload.items) {
      // Dedup check
      if (this.seenMeshIds.has(meshItem.meshId)) {
        rejected++;
        continue;
      }

      // Hop check
      if (meshItem.hops >= meshItem.maxHops) {
        rejected++;
        continue;
      }

      // TTL check
      if (meshItem.expiresAt < Date.now()) {
        rejected++;
        continue;
      }

      // Accept: inject into local workspace
      this.markSeen(meshItem.meshId);
      meshItem.hops++;

      this.workspace.broadcast({
        ...meshItem.item,
        source: `mesh:${meshItem.originDeviceId}`,
        // Reduce salience slightly for mesh-propagated items
        salience: meshItem.item.salience * 0.9,
      });

      // Track for snapshot
      this.recentMeshItems.push(meshItem);
      accepted++;
    }

    if (this.recentMeshItems.length > SNAPSHOT_LIMIT * 2) {
      this.recentMeshItems = this.recentMeshItems.slice(-SNAPSHOT_LIMIT);
    }

    return { accepted, rejected };
  }

  // --------------------------------------------------------------------------
  // PULL — Fallback: fetch from peer during health checks
  // --------------------------------------------------------------------------

  /** Pull consciousness items from a peer (called during PeerMonitor health check). */
  async pullFromPeer(peer: MeshPeer): Promise<number> {
    const url = peer.tunnelUrl || peer.baseUrl;
    if (!url) return 0;

    try {
      const headers: Record<string, string> = {};
      if (peer.peerToken) headers['X-Peer-Token'] = peer.peerToken;

      const response = await fetch(`${url}/api/mesh/consciousness?limit=${SNAPSHOT_LIMIT}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return 0;

      const data = await response.json() as MeshConsciousnessResponse;
      let injected = 0;

      for (const meshItem of data.items) {
        if (this.seenMeshIds.has(meshItem.meshId)) continue;
        if (meshItem.expiresAt < Date.now()) continue;

        this.markSeen(meshItem.meshId);
        this.workspace.broadcast({
          ...meshItem.item,
          source: `mesh:${meshItem.originDeviceId}`,
          salience: meshItem.item.salience * 0.85, // slightly lower for pull (may be stale)
        });
        injected++;
      }

      return injected;
    } catch {
      return 0;
    }
  }

  // --------------------------------------------------------------------------
  // SNAPSHOT — For GET /api/mesh/consciousness
  // --------------------------------------------------------------------------

  /** Get a consciousness snapshot for peers to pull. */
  getConsciousnessSnapshot(limit: number = SNAPSHOT_LIMIT): MeshConsciousnessResponse {
    // Combine local workspace items with mesh-propagated items
    const localItems = this.workspace.getConscious(limit)
      .filter(item => !item.source.startsWith('mesh:'))
      .map(item => this.wrapItem(item));

    const allItems = [...localItems, ...this.recentMeshItems]
      .filter(item => item.expiresAt > Date.now())
      .sort((a, b) => b.item.salience - a.item.salience)
      .slice(0, limit);

    return {
      items: allItems,
      deviceId: this.localDeviceId,
      deviceName: this.localDeviceName,
      workspaceSize: this.workspace.size(),
      timestamp: Date.now(),
    };
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  private wrapItem(item: WorkspaceItem): MeshConsciousnessItem {
    const meshId = crypto
      .createHash('md5')
      .update(`${this.localDeviceId}:${item.source}:${item.content}:${item.timestamp}`)
      .digest('hex');

    return {
      item,
      meshId,
      originDeviceId: this.localDeviceId,
      hops: 0,
      maxHops: MAX_HOPS,
      expiresAt: Date.now() + CONSCIOUSNESS_TTL_MS,
    };
  }

  private markSeen(meshId: string): void {
    if (this.seenMeshIds.size >= MAX_SEEN_SET_SIZE) {
      // LRU eviction: remove oldest
      const oldest = this.seenOrder.shift();
      if (oldest) this.seenMeshIds.delete(oldest);
    }
    this.seenMeshIds.add(meshId);
    this.seenOrder.push(meshId);
  }
}
