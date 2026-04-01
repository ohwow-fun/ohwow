/**
 * Consciousness Bridge — Persistence and sync for the Global Workspace.
 *
 * Connects the in-memory Global Workspace (Baars) to:
 * 1. Local SQLite (consciousness_items table) for persistence across restarts
 * 2. Cloud control plane for shared consciousness with the cloud dashboard
 *
 * High-salience items from the workspace are written to SQLite.
 * On startup, recent items are hydrated back into the workspace.
 * Cloud items received via control plane sync are merged in.
 *
 * Category mapping (local workspace types → cloud categories):
 *   failure, warning → alert
 *   discovery, pattern → insight
 *   skill → milestone
 *   signal → prediction
 *   (anything else) → anomaly
 */

import type { DatabaseAdapter } from '../db/adapter-types.js';
import type { GlobalWorkspace } from './global-workspace.js';
import type { WorkspaceItem } from './types.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// TYPE MAPPING
// ============================================================================

type ConsciousnessCategory = 'alert' | 'insight' | 'prediction' | 'milestone' | 'anomaly';

const TYPE_TO_CATEGORY: Record<string, ConsciousnessCategory> = {
  failure: 'alert',
  warning: 'alert',
  discovery: 'insight',
  pattern: 'insight',
  skill: 'milestone',
  signal: 'prediction',
  // New philosophical layers
  affect: 'insight',
  hormonal: 'insight',
  immune: 'alert',
  dream: 'insight',
  narrative: 'milestone',
  ethical: 'alert',
  habit: 'insight',
};

const CATEGORY_TO_TYPE: Record<ConsciousnessCategory, WorkspaceItem['type']> = {
  alert: 'warning',
  insight: 'discovery',
  prediction: 'signal',
  milestone: 'skill',
  anomaly: 'warning',
};

function toCategory(type: string): ConsciousnessCategory {
  return TYPE_TO_CATEGORY[type] ?? 'anomaly';
}

function toWorkspaceType(category: ConsciousnessCategory): WorkspaceItem['type'] {
  return CATEGORY_TO_TYPE[category] ?? 'warning';
}

// ============================================================================
// PERSISTENCE THRESHOLD
// ============================================================================

/** Only persist items with salience above this threshold */
const PERSIST_SALIENCE_THRESHOLD = 0.4;

/** Maximum age of items to hydrate on startup (24 hours) */
const HYDRATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Maximum items to keep in the table (auto-prune old ones) */
const MAX_PERSISTED_ITEMS = 500;

// ============================================================================
// CONSCIOUSNESS BRIDGE
// ============================================================================

interface ConsciousnessRow {
  id: string;
  workspace_id: string;
  source: string;
  content: string;
  salience: number;
  category: ConsciousnessCategory;
  created_at: string;
  origin: string;
}

export class ConsciousnessBridge {
  private persistedIds = new Set<string>();

  constructor(
    private db: DatabaseAdapter,
    private workspace: GlobalWorkspace,
    private workspaceId: string,
  ) {}

  /**
   * Hydrate the Global Workspace from persisted consciousness items.
   * Called once on startup.
   */
  async hydrate(): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - HYDRATE_MAX_AGE_MS).toISOString();
      const { data } = await this.db.from<ConsciousnessRow>('consciousness_items')
        .select('*')
        .eq('workspace_id', this.workspaceId)
        .gte('created_at', cutoff)
        .order('salience', { ascending: false })
        .limit(50);

      if (!data || data.length === 0) return 0;

      for (const row of data) {
        const item: WorkspaceItem = {
          source: `${row.origin}:${row.source}`,
          type: toWorkspaceType(row.category as ConsciousnessCategory),
          content: row.content,
          salience: row.salience,
          timestamp: new Date(row.created_at).getTime(),
          metadata: { consciousnessId: row.id, origin: row.origin },
        };
        this.workspace.broadcast(item);
        this.persistedIds.add(contentHash(row.source, row.content));
      }

      logger.info(
        { count: data.length },
        '[ConsciousnessBridge] Hydrated workspace from persistence',
      );
      return data.length;
    } catch (err) {
      logger.debug({ err }, '[ConsciousnessBridge] Hydration failed (table may not exist yet)');
      return 0;
    }
  }

  /**
   * Persist high-salience workspace items to SQLite.
   * Called periodically (e.g., after each orchestrator turn or on flush).
   */
  async persist(): Promise<number> {
    try {
      const items = this.workspace.getConscious(20, { minSalience: PERSIST_SALIENCE_THRESHOLD });
      let persisted = 0;

      for (const item of items) {
        const hash = contentHash(item.source, item.content);
        if (this.persistedIds.has(hash)) continue;

        await this.db.from('consciousness_items').insert({
          workspace_id: this.workspaceId,
          source: item.source,
          content: item.content,
          salience: item.salience,
          category: toCategory(item.type),
          created_at: new Date(item.timestamp).toISOString(),
          origin: 'local',
        });

        this.persistedIds.add(hash);
        persisted++;
      }

      if (persisted > 0) {
        logger.debug({ persisted }, '[ConsciousnessBridge] Persisted consciousness items');
      }

      // Auto-prune oldest items if over capacity
      await this.prune();

      return persisted;
    } catch (err) {
      logger.debug({ err }, '[ConsciousnessBridge] Persistence failed');
      return 0;
    }
  }

  /**
   * Merge cloud consciousness items into the local workspace.
   * Called when control plane delivers cloud items during sync.
   */
  async mergeCloudItems(items: CloudConsciousnessItem[]): Promise<number> {
    let merged = 0;

    for (const cloudItem of items) {
      const hash = contentHash(cloudItem.source, cloudItem.content);
      if (this.persistedIds.has(hash)) continue;

      // Persist to local DB
      try {
        await this.db.from('consciousness_items').insert({
          workspace_id: this.workspaceId,
          source: cloudItem.source,
          content: cloudItem.content,
          salience: cloudItem.salience,
          category: cloudItem.category,
          created_at: cloudItem.created_at,
          origin: 'cloud',
        });
      } catch {
        // Duplicate or table not ready
        continue;
      }

      // Broadcast to in-memory workspace
      const workspaceItem: WorkspaceItem = {
        source: `cloud:${cloudItem.source}`,
        type: toWorkspaceType(cloudItem.category as ConsciousnessCategory),
        content: cloudItem.content,
        salience: cloudItem.salience,
        timestamp: new Date(cloudItem.created_at).getTime(),
        metadata: { consciousnessId: cloudItem.id, origin: 'cloud' },
      };
      this.workspace.broadcast(workspaceItem);
      this.persistedIds.add(hash);
      merged++;
    }

    if (merged > 0) {
      logger.info({ merged }, '[ConsciousnessBridge] Merged cloud consciousness items');
    }

    return merged;
  }

  /**
   * Get local consciousness items for cloud sync (outbound).
   * Returns items that haven't been synced yet.
   */
  async getUnsyncedItems(): Promise<CloudConsciousnessItem[]> {
    try {
      const { data } = await this.db.from<ConsciousnessRow>('consciousness_items')
        .select('*')
        .eq('workspace_id', this.workspaceId)
        .eq('origin', 'local')
        .is('synced_at', null)
        .order('created_at', { ascending: false })
        .limit(20);

      if (!data) return [];

      return data.map(row => ({
        id: row.id,
        workspace_id: row.workspace_id,
        source: row.source,
        content: row.content,
        salience: row.salience,
        category: row.category as ConsciousnessCategory,
        created_at: row.created_at,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Mark items as synced to cloud.
   */
  async markSynced(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      for (const id of ids) {
        await this.db.from('consciousness_items')
          .update({ synced_at: new Date().toISOString() })
          .eq('id', id);
      }
    } catch (err) {
      logger.debug({ err }, '[ConsciousnessBridge] Failed to mark items as synced');
    }
  }

  /**
   * Remove old items to stay within capacity.
   */
  private async prune(): Promise<void> {
    try {
      const { count } = await this.db.from('consciousness_items')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', this.workspaceId);

      if (count && count > MAX_PERSISTED_ITEMS) {
        // Delete oldest items beyond capacity
        const excess = count - MAX_PERSISTED_ITEMS;
        const { data: oldest } = await this.db.from<ConsciousnessRow>('consciousness_items')
          .select('id')
          .eq('workspace_id', this.workspaceId)
          .order('created_at', { ascending: true })
          .limit(excess);

        if (oldest) {
          for (const row of oldest) {
            await this.db.from('consciousness_items').delete().eq('id', row.id);
          }
        }
      }
    } catch {
      // Non-critical
    }
  }
}

// ============================================================================
// SHARED TYPES
// ============================================================================

/** Cloud consciousness item format (matches Supabase schema) */
export interface CloudConsciousnessItem {
  id: string;
  workspace_id: string;
  source: string;
  content: string;
  salience: number;
  category: 'alert' | 'insight' | 'prediction' | 'milestone' | 'anomaly';
  created_at: string;
}

// ============================================================================
// INTERNAL
// ============================================================================

function contentHash(source: string, content: string): string {
  // Simple hash for dedup — not cryptographic
  let hash = 0;
  const str = `${source}:${content}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}
