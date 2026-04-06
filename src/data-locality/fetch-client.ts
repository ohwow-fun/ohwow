/**
 * Device Data Fetch Client
 *
 * Fetches device-pinned data from remote devices.
 * Transport priority: LAN peer → Cloudflare tunnel → cloud relay.
 * All payloads are E2E encrypted (cloud relay never sees plaintext).
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import {
  generateEphemeralKeypair,
  encryptForRecipient,
  decryptWithPrivateKey,
  type EncryptedPayload,
} from './crypto.js';
import { EphemeralCache } from './ephemeral-cache.js';
import { findManifestEntry, recordFetch, type ManifestEntry } from './manifest.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface FetchResult {
  data: unknown;
  accessPolicy: string;
  cacheTtl: number;
  transport: 'lan' | 'tunnel' | 'relay' | 'cache';
  latencyMs: number;
}

interface PeerInfo {
  deviceId: string;
  baseUrl: string | null;
  tunnelUrl: string | null;
  peerToken: string;
}

interface FetchClientDeps {
  db: DatabaseAdapter;
  workspaceId: string;
  /** Our device ID */
  deviceId: string;
  /** Cloud URL for relay fallback */
  cloudUrl: string;
  /** Session token for cloud auth */
  sessionToken: string | null;
  /** Function to resolve peer info from device ID */
  resolvePeer: (deviceId: string) => Promise<PeerInfo | null>;
}

// ============================================================================
// FETCH CLIENT
// ============================================================================

export class DeviceDataFetcher {
  private cache: EphemeralCache;
  private deps: FetchClientDeps;

  constructor(deps: FetchClientDeps) {
    this.deps = deps;
    this.cache = new EphemeralCache();
  }

  /**
   * Fetch data from the device that owns it.
   * Checks cache first, then tries LAN → tunnel → cloud relay.
   */
  async fetch(dataId: string): Promise<FetchResult> {
    const start = Date.now();

    // 1. Check ephemeral cache first
    const cached = this.cache.get(dataId);
    if (cached) {
      return {
        data: cached,
        accessPolicy: 'cached',
        cacheTtl: 0,
        transport: 'cache',
        latencyMs: Date.now() - start,
      };
    }

    // 2. Find manifest entry (local copy from sync)
    const entry = await findManifestEntry(this.deps.db, dataId);
    if (!entry) {
      throw new DataNotFoundError(dataId);
    }

    // 3. Don't fetch from ourselves
    if (entry.deviceId === this.deps.deviceId) {
      throw new Error('Data is on this device — use local DB directly');
    }

    // 4. Resolve peer connection info
    const peer = await this.deps.resolvePeer(entry.deviceId);
    if (!peer) {
      throw new DeviceOfflineError(entry.deviceId, entry.title);
    }

    // 5. Generate ephemeral keypair for this request
    const keypair = generateEphemeralKeypair();

    // 6. Try transports in priority order
    let result: FetchResult | null = null;

    // Try LAN first
    if (peer.baseUrl) {
      result = await this.tryFetch(
        `${peer.baseUrl}/api/data-locality/fetch`,
        { 'X-Peer-Token': peer.peerToken },
        dataId,
        keypair,
        'lan',
        start,
      );
    }

    // Try tunnel if LAN failed
    if (!result && peer.tunnelUrl) {
      result = await this.tryFetch(
        `${peer.tunnelUrl}/api/data-locality/fetch`,
        { 'X-Peer-Token': peer.peerToken },
        dataId,
        keypair,
        'tunnel',
        start,
      );
    }

    // Try cloud relay as last resort
    if (!result && this.deps.sessionToken) {
      result = await this.tryCloudRelay(
        entry.deviceId,
        dataId,
        keypair,
        start,
      );
    }

    if (!result) {
      throw new DeviceOfflineError(entry.deviceId, entry.title);
    }

    // 7. Cache based on access policy
    this.cache.set(dataId, result.data, result.accessPolicy, entry.deviceId);

    // 8. Record access on our local manifest copy
    await recordFetch(this.deps.db, dataId).catch(() => {});

    return result;
  }

  /**
   * Try fetching from a direct URL (LAN or tunnel).
   */
  private async tryFetch(
    url: string,
    headers: Record<string, string>,
    dataId: string,
    keypair: ReturnType<typeof generateEphemeralKeypair>,
    transport: 'lan' | 'tunnel',
    startTime: number,
  ): Promise<FetchResult | null> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          dataId,
          requestingDeviceId: this.deps.deviceId,
          ephemeralPublicKey: keypair.publicKey,
        }),
        signal: AbortSignal.timeout(transport === 'lan' ? 5_000 : 15_000),
      });

      if (!response.ok) {
        if (response.status === 403) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          throw new AccessDeniedError(dataId, body.error ?? 'Access denied');
        }
        return null;
      }

      const body = await response.json() as {
        data: unknown;
        encryptedPayload?: EncryptedPayload;
        accessPolicy: string;
        cacheTtl: number;
      };

      // If response is encrypted, decrypt it
      let data: unknown;
      if (body.encryptedPayload) {
        const decrypted = decryptWithPrivateKey(body.encryptedPayload, keypair.privateKey);
        data = JSON.parse(decrypted.toString('utf-8'));
      } else {
        data = body.data;
      }

      return {
        data,
        accessPolicy: body.accessPolicy,
        cacheTtl: body.cacheTtl,
        transport,
        latencyMs: Date.now() - startTime,
      };
    } catch (err) {
      if (err instanceof AccessDeniedError) throw err;
      logger.debug({ err, transport, dataId }, '[fetch-client] Transport failed, trying next');
      return null;
    }
  }

  /**
   * Relay fetch through the cloud. Cloud sees only encrypted blobs.
   */
  private async tryCloudRelay(
    targetDeviceId: string,
    dataId: string,
    keypair: ReturnType<typeof generateEphemeralKeypair>,
    startTime: number,
  ): Promise<FetchResult | null> {
    try {
      const response = await fetch(`${this.deps.cloudUrl}/api/local-runtime/relay-fetch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.deps.sessionToken}`,
        },
        body: JSON.stringify({
          targetDeviceId,
          dataId,
          ephemeralPublicKey: keypair.publicKey,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) return null;

      const body = await response.json() as {
        encryptedPayload?: EncryptedPayload;
        accessPolicy?: string;
        cacheTtl?: number;
        status?: string;
      };

      if (body.status === 'offline' || !body.encryptedPayload) return null;

      const decrypted = decryptWithPrivateKey(body.encryptedPayload, keypair.privateKey);
      const data = JSON.parse(decrypted.toString('utf-8'));

      return {
        data,
        accessPolicy: body.accessPolicy ?? 'ephemeral',
        cacheTtl: body.cacheTtl ?? 0,
        transport: 'relay',
        latencyMs: Date.now() - startTime,
      };
    } catch (err) {
      logger.debug({ err, dataId }, '[fetch-client] Cloud relay failed');
      return null;
    }
  }

  /** Destroy the ephemeral cache. Call on shutdown. */
  destroy(): void {
    this.cache.destroy();
  }
}

// ============================================================================
// ERRORS
// ============================================================================

export class DataNotFoundError extends Error {
  constructor(public dataId: string) {
    super(`Data "${dataId}" not found in manifest`);
    this.name = 'DataNotFoundError';
  }
}

export class DeviceOfflineError extends Error {
  constructor(public deviceId: string, public dataTitle?: string) {
    super(
      dataTitle
        ? `"${dataTitle}" is on a device that's currently offline`
        : `Device ${deviceId} is offline`,
    );
    this.name = 'DeviceOfflineError';
  }
}

export class AccessDeniedError extends Error {
  constructor(public dataId: string, reason: string) {
    super(`Access denied for "${dataId}": ${reason}`);
    this.name = 'AccessDeniedError';
  }
}
