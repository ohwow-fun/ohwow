/**
 * Doc Mount Mesh Sync
 *
 * Discovers and tracks doc mounts available on mesh peers.
 * Called during peer heartbeat to keep the peer mirror table in sync.
 */

import { randomUUID } from 'crypto';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface PeerMountInfo {
  id: string;
  url: string;
  domain: string;
  namespace: string;
  pageCount: number;
  crawledAt: string | null;
}

// ============================================================================
// SYNC
// ============================================================================

/**
 * Fetch doc mounts from a peer and update the local mirror table.
 * Called during peer heartbeat or on-demand.
 */
export async function syncPeerMounts(
  db: DatabaseAdapter,
  peerId: string,
  peerBaseUrl: string,
  peerToken: string,
): Promise<number> {
  try {
    const response = await fetch(`${peerBaseUrl}/api/peers/doc-mounts`, {
      headers: { 'X-Peer-Token': peerToken },
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) return 0;

    const data = await response.json() as { mounts?: PeerMountInfo[] };
    const mounts = data.mounts ?? [];

    if (mounts.length === 0) return 0;

    let synced = 0;
    for (const mount of mounts) {
      // Upsert into peer mirrors
      const { error: insertError } = await db
        .from('doc_mount_peer_mirrors')
        .insert({
          id: randomUUID(),
          mount_namespace: mount.namespace,
          peer_id: peerId,
          peer_mount_id: mount.id,
          url: mount.url,
          domain: mount.domain,
          page_count: mount.pageCount,
          crawled_at: mount.crawledAt,
        });

      if (insertError) {
        // Update existing
        await db
          .from('doc_mount_peer_mirrors')
          .update({
            peer_mount_id: mount.id,
            url: mount.url,
            page_count: mount.pageCount,
            crawled_at: mount.crawledAt,
            discovered_at: new Date().toISOString(),
          })
          .eq('mount_namespace', mount.namespace)
          .eq('peer_id', peerId);
      }
      synced++;
    }

    logger.debug({ peerId, synced }, '[doc-mount-mesh] Synced peer mounts');
    return synced;
  } catch (err) {
    logger.debug({ err, peerId }, '[doc-mount-mesh] Peer mount sync failed');
    return 0;
  }
}

/**
 * Get all doc mounts available on mesh peers.
 * Useful for showing the agent what peer docs are available.
 */
export async function listPeerMounts(
  db: DatabaseAdapter,
): Promise<Array<{
  namespace: string;
  url: string;
  domain: string;
  peerId: string;
  peerMountId: string;
  pageCount: number;
}>> {
  const { data } = await db
    .from('doc_mount_peer_mirrors')
    .select('mount_namespace, url, domain, peer_id, peer_mount_id, page_count');

  if (!data) return [];

  return (data as Array<{
    mount_namespace: string;
    url: string;
    domain: string;
    peer_id: string;
    peer_mount_id: string;
    page_count: number;
  }>).map((row) => ({
    namespace: row.mount_namespace,
    url: row.url,
    domain: row.domain,
    peerId: row.peer_id,
    peerMountId: row.peer_mount_id,
    pageCount: row.page_count,
  }));
}

/**
 * Remove all mirrors for a disconnected peer.
 */
export async function removePeerMirrors(
  db: DatabaseAdapter,
  peerId: string,
): Promise<void> {
  await db
    .from('doc_mount_peer_mirrors')
    .delete()
    .eq('peer_id', peerId);
}
