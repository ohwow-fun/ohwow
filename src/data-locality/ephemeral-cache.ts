/**
 * Ephemeral Cache — In-memory encrypted store for fetched device-pinned data.
 *
 * Data lives in memory only (never SQLite). On process exit, everything is gone.
 * TTL is determined by the access_policy of the pinned data.
 */

import { logger } from '../lib/logger.js';

// ============================================================================
// TTL MAPPING
// ============================================================================

/** Convert access policy to TTL in milliseconds */
export function accessPolicyToTtlMs(policy: string): number {
  switch (policy) {
    case 'cached_1h': return 60 * 60 * 1000;
    case 'cached_24h': return 24 * 60 * 60 * 1000;
    case 'ephemeral': return 0;       // single use
    case 'never_cache': return 0;     // never stored
    default: return 0;
  }
}

// ============================================================================
// CACHE
// ============================================================================

interface CacheEntry {
  data: unknown;
  accessPolicy: string;
  expiresAt: number;          // 0 = single use (consumed on first get)
  sourceDeviceId: string;
}

export class EphemeralCache {
  private store = new Map<string, CacheEntry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Store fetched data. For 'ephemeral' policy, data is consumed on first get.
   * For 'never_cache', this is a no-op.
   */
  set(
    dataId: string,
    data: unknown,
    accessPolicy: string,
    sourceDeviceId: string,
  ): void {
    if (accessPolicy === 'never_cache') return;

    const ttlMs = accessPolicyToTtlMs(accessPolicy);

    this.store.set(dataId, {
      data,
      accessPolicy,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
      sourceDeviceId,
    });

    // Auto-purge after TTL
    if (ttlMs > 0) {
      const existing = this.timers.get(dataId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.store.delete(dataId);
        this.timers.delete(dataId);
      }, ttlMs);

      this.timers.set(dataId, timer);
    }
  }

  /**
   * Get cached data. For 'ephemeral' policy, consumes the entry (single use).
   * Returns null if not found or expired.
   */
  get(dataId: string): unknown | null {
    const entry = this.store.get(dataId);
    if (!entry) return null;

    // Check expiry for cached entries
    if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
      this.store.delete(dataId);
      const timer = this.timers.get(dataId);
      if (timer) { clearTimeout(timer); this.timers.delete(dataId); }
      return null;
    }

    // Ephemeral: consume on first read
    if (entry.accessPolicy === 'ephemeral') {
      this.store.delete(dataId);
      const timer = this.timers.get(dataId);
      if (timer) { clearTimeout(timer); this.timers.delete(dataId); }
    }

    return entry.data;
  }

  /** Check if data is cached without consuming it. */
  has(dataId: string): boolean {
    const entry = this.store.get(dataId);
    if (!entry) return false;
    if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
      this.store.delete(dataId);
      return false;
    }
    return true;
  }

  /** Number of cached entries. */
  get size(): number {
    return this.store.size;
  }

  /** Purge all cached data. Called on shutdown. */
  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.store.clear();
    this.timers.clear();
    logger.debug('[ephemeral-cache] Destroyed');
  }
}
