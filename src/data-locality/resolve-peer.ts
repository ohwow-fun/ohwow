/**
 * Resolve Peer — Maps a cloud device_id to reachable connection info.
 *
 * Tries three data sources:
 * 1. Local workspace_peers table (mDNS-discovered peers on LAN)
 * 2. Cloud device manifest (other devices' cached entries with tunnel URLs)
 * 3. Cloud API (query local_runtime_status for device's tunnel_url)
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

export interface PeerInfo {
  deviceId: string;
  baseUrl: string | null;
  tunnelUrl: string | null;
  peerToken: string;
}

/**
 * Create a resolvePeer function for the DeviceDataFetcher.
 * Closes over the database and control plane for lookups.
 */
export function createPeerResolver(
  db: DatabaseAdapter,
  opts?: {
    cloudUrl?: string;
    sessionToken?: string | null;
  },
): (deviceId: string) => Promise<PeerInfo | null> {
  return async (deviceId: string): Promise<PeerInfo | null> => {
    // 1. Check local workspace_peers for connected peers
    //    These are mDNS-discovered and have peer tokens for auth.
    //    Match by checking if the peer's machine_id corresponds to the device.
    const { data: peers } = await db
      .from('workspace_peers')
      .select('id, base_url, tunnel_url, our_token, status, machine_id')
      .eq('status', 'connected');

    if (peers && (peers as unknown[]).length > 0) {
      // We need to map deviceId (from local_runtime_status) to workspace_peers.
      // The manifest entries cached locally have device_id. We check if any peer
      // matches by looking at the manifest entries' device_id and the peers' URLs.
      const { data: manifestEntry } = await db
        .from('device_data_manifest')
        .select('device_id')
        .eq('device_id', deviceId)
        .limit(1)
        .maybeSingle();

      // Try matching peers by checking if their tunnel_url or base_url
      // is known for this device
      for (const peer of peers as Array<Record<string, unknown>>) {
        // Direct match if we stored device mapping during sync
        const peerBaseUrl = peer.base_url as string;
        const peerTunnelUrl = peer.tunnel_url as string | null;
        const ourToken = peer.our_token as string;

        // For now, return the first connected peer if we have one
        // In a multi-peer setup, we'd match by machine_id
        if (manifestEntry) {
          return {
            deviceId,
            baseUrl: peerBaseUrl,
            tunnelUrl: peerTunnelUrl,
            peerToken: ourToken,
          };
        }
      }
    }

    // 2. Query cloud for device's tunnel URL (if we have a session)
    if (opts?.cloudUrl && opts.sessionToken) {
      try {
        const response = await fetch(
          `${opts.cloudUrl}/api/local-runtime/device-info?deviceId=${deviceId}`,
          {
            headers: { 'Authorization': `Bearer ${opts.sessionToken}` },
            signal: AbortSignal.timeout(5_000),
          },
        );

        if (response.ok) {
          const data = await response.json() as {
            tunnelUrl?: string;
            localUrl?: string;
            status?: string;
          };

          if (data.status !== 'connected') return null;

          if (data.tunnelUrl || data.localUrl) {
            return {
              deviceId,
              baseUrl: data.localUrl ?? null,
              tunnelUrl: data.tunnelUrl ?? null,
              // No peer token for cloud-resolved devices — use content token auth
              peerToken: opts.sessionToken!,
            };
          }
        }
      } catch {
        logger.debug({ deviceId }, '[resolve-peer] Cloud lookup failed');
      }
    }

    return null;
  };
}
