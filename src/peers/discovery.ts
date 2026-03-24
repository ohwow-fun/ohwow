/**
 * Peer Discovery via mDNS (Bonjour/Avahi)
 * Automatically discovers other OHWOW workspaces on the local network.
 * Pure JS implementation via bonjour-service (no native dependencies).
 */

import { Bonjour, type Service, type Browser } from 'bonjour-service';
import { logger } from '../lib/logger.js';

const SERVICE_TYPE = 'ohwow-workspace';

export interface DiscoveredPeer {
  name: string;
  host: string;
  port: number;
  deviceId: string;
  memoryTier: string;
  version: string;
  url: string;
  deviceRole: string;
  workspaceGroup: string;
  /** Comma-separated list of messaging channel types this peer owns (e.g. "whatsapp,telegram") */
  messagingChannels: string;
  /** Comma-separated list of connection IDs this peer owns */
  ownedConnectionIds: string;
}

export interface PeerDiscoveryCallbacks {
  onPeerFound: (peer: DiscoveredPeer) => void;
  onPeerLost: (peer: DiscoveredPeer) => void;
}

export class PeerDiscovery {
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private published = false;
  private myDeviceId: string;
  private myWorkspaceGroup = 'default';
  private discoveredPeers = new Map<string, DiscoveredPeer>();

  constructor(private callbacks: PeerDiscoveryCallbacks) {
    this.myDeviceId = '';
  }

  /**
   * Advertise this workspace on the local network via mDNS.
   */
  advertise(port: number, metadata: { name: string; deviceId: string; memoryTier: string; version: string; deviceRole: string; workspaceGroup: string; messagingChannels?: string; ownedConnectionIds?: string }): void {
    try {
      this.bonjour = new Bonjour();
      this.myDeviceId = metadata.deviceId;
      this.myWorkspaceGroup = metadata.workspaceGroup;

      this.bonjour.publish({
        name: `ohwow-${metadata.name}-${metadata.deviceId.slice(0, 8)}`,
        type: SERVICE_TYPE,
        port,
        txt: {
          deviceId: metadata.deviceId,
          memoryTier: metadata.memoryTier,
          version: metadata.version,
          name: metadata.name,
          deviceRole: metadata.deviceRole,
          workspaceGroup: metadata.workspaceGroup,
          messagingChannels: metadata.messagingChannels || '',
          ownedConnectionIds: metadata.ownedConnectionIds || '',
        },
      });

      this.published = true;
      logger.info(`[PeerDiscovery] Advertising on mDNS: ${metadata.name} (port ${port})`);
    } catch (err) {
      logger.warn(`[PeerDiscovery] mDNS advertisement failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Browse for other OHWOW workspaces on the network.
   */
  browse(): void {
    if (!this.bonjour) {
      this.bonjour = new Bonjour();
    }

    try {
      const browser = this.bonjour.find({ type: SERVICE_TYPE });
      this.browser = browser;

      browser.on('up', (service: Service) => {
        const txt = service.txt as Record<string, string> | undefined;
        const deviceId = txt?.deviceId || '';

        // Skip self
        if (deviceId === this.myDeviceId) return;

        // Filter by workspace group
        const peerGroup = txt?.workspaceGroup || 'default';
        if (peerGroup !== this.myWorkspaceGroup) return;

        // Skip already discovered
        if (this.discoveredPeers.has(deviceId)) return;

        const peer: DiscoveredPeer = {
          name: txt?.name || service.name,
          host: service.host,
          port: service.port,
          deviceId,
          memoryTier: txt?.memoryTier || 'unknown',
          version: txt?.version || 'unknown',
          url: `http://${service.host}:${service.port}`,
          deviceRole: txt?.deviceRole || 'hybrid',
          workspaceGroup: peerGroup,
          messagingChannels: txt?.messagingChannels || '',
          ownedConnectionIds: txt?.ownedConnectionIds || '',
        };

        this.discoveredPeers.set(deviceId, peer);
        logger.info(`[PeerDiscovery] Found peer: ${peer.name} at ${peer.url}`);
        this.callbacks.onPeerFound(peer);
      });

      browser.on('down', (service: Service) => {
        const txt = service.txt as Record<string, string> | undefined;
        const deviceId = txt?.deviceId || '';
        const peer = this.discoveredPeers.get(deviceId);

        if (peer) {
          this.discoveredPeers.delete(deviceId);
          logger.info(`[PeerDiscovery] Lost peer: ${peer.name}`);
          this.callbacks.onPeerLost(peer);
        }
      });

      logger.info('[PeerDiscovery] Browsing for peers on local network...');
    } catch (err) {
      logger.warn(`[PeerDiscovery] mDNS browse failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Get all currently discovered peers.
   */
  getDiscoveredPeers(): DiscoveredPeer[] {
    return Array.from(this.discoveredPeers.values());
  }

  /**
   * Stop advertising and browsing.
   */
  stop(): void {
    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }
    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }
    this.published = false;
    this.discoveredPeers.clear();
    logger.info('[PeerDiscovery] Stopped');
  }

  get isAdvertising(): boolean {
    return this.published;
  }
}
