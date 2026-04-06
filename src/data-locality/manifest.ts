/**
 * Device Data Manifest — Local Runtime
 *
 * Manages the catalog of data pinned to this device.
 * The manifest syncs to cloud and peers; the actual data never leaves.
 */

import crypto from 'crypto';
import type { DatabaseAdapter } from '../db/adapter-types.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export type PinnedDataType = 'memory' | 'conversation' | 'knowledge_doc' | 'file' | 'credential';
export type AccessPolicy = 'ephemeral' | 'cached_1h' | 'cached_24h' | 'never_cache';
export type LocalityPolicy = 'sync' | 'device_pinned' | 'device_sealed';

export interface ManifestEntry {
  id: string;
  workspaceId: string;
  deviceId: string;
  dataType: PinnedDataType;
  dataId: string;
  title: string;
  tags: string[];
  sizeBytes: number;
  accessPolicy: AccessPolicy;
  requiresApproval: boolean;
  ownerUserId: string | null;
  pinnedAt: string;
  lastFetchedAt: string | null;
  fetchCount: number;
}

export interface PinDataOpts {
  dataType: PinnedDataType;
  dataId: string;
  title: string;
  tags?: string[];
  accessPolicy?: AccessPolicy;
  requiresApproval?: boolean;
  ownerUserId?: string;
}

// ============================================================================
// PIN / UNPIN
// ============================================================================

/**
 * Pin data to this device. Creates a manifest entry and sets
 * locality_policy on the source data row.
 */
export async function pinData(
  db: DatabaseAdapter,
  workspaceId: string,
  deviceId: string,
  opts: PinDataOpts,
): Promise<ManifestEntry> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Create manifest entry
  await db.from('device_data_manifest').insert({
    id,
    workspace_id: workspaceId,
    device_id: deviceId,
    data_type: opts.dataType,
    data_id: opts.dataId,
    title: opts.title,
    tags: JSON.stringify(opts.tags ?? []),
    size_bytes: 0,
    access_policy: opts.accessPolicy ?? 'ephemeral',
    requires_approval: opts.requiresApproval ? 1 : 0,
    owner_user_id: opts.ownerUserId ?? null,
    pinned_at: now,
    fetch_count: 0,
    created_at: now,
  });

  // Set locality_policy on the source data
  const table = dataTypeToTable(opts.dataType);
  if (table) {
    await db.from(table)
      .update({ locality_policy: 'device_pinned' })
      .eq('id', opts.dataId);
  }

  logger.info({ dataType: opts.dataType, dataId: opts.dataId, title: opts.title }, '[manifest] Data pinned to device');

  return {
    id,
    workspaceId,
    deviceId,
    dataType: opts.dataType,
    dataId: opts.dataId,
    title: opts.title,
    tags: opts.tags ?? [],
    sizeBytes: 0,
    accessPolicy: opts.accessPolicy ?? 'ephemeral',
    requiresApproval: opts.requiresApproval ?? false,
    ownerUserId: opts.ownerUserId ?? null,
    pinnedAt: now,
    lastFetchedAt: null,
    fetchCount: 0,
  };
}

/**
 * Unpin data from this device. Removes the manifest entry and
 * sets locality_policy back to 'sync' so data can sync normally.
 */
export async function unpinData(
  db: DatabaseAdapter,
  dataId: string,
  deviceId: string,
): Promise<void> {
  // Get the manifest entry to find the data type (only this device's entry)
  const { data: entry } = await db
    .from('device_data_manifest')
    .select('data_type')
    .eq('data_id', dataId)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (!entry) return;

  const typedEntry = entry as { data_type: string };

  // Remove only this device's manifest entry
  await db.from('device_data_manifest')
    .delete()
    .eq('data_id', dataId)
    .eq('device_id', deviceId);

  // Restore sync policy on source data
  const table = dataTypeToTable(typedEntry.data_type as PinnedDataType);
  if (table) {
    await db.from(table)
      .update({ locality_policy: 'sync' })
      .eq('id', dataId);
  }

  logger.info({ dataId }, '[manifest] Data unpinned from device');
}

/**
 * Seal data on this device. Not even the manifest is shared.
 * Data is completely invisible to other devices and the cloud.
 */
export async function sealData(
  db: DatabaseAdapter,
  dataId: string,
  dataType: PinnedDataType,
  deviceId?: string,
): Promise<void> {
  // Remove manifest entries (sealed data is not discoverable)
  let query = db.from('device_data_manifest')
    .delete()
    .eq('data_id', dataId);
  if (deviceId) query = query.eq('device_id', deviceId);
  await query;

  // Set locality_policy to sealed
  const table = dataTypeToTable(dataType);
  if (table) {
    await db.from(table)
      .update({ locality_policy: 'device_sealed' })
      .eq('id', dataId);
  }

  logger.info({ dataId, dataType }, '[manifest] Data sealed to device');
}

// ============================================================================
// QUERY
// ============================================================================

/**
 * Get all manifest entries for this device.
 */
export async function getLocalManifest(
  db: DatabaseAdapter,
  workspaceId: string,
): Promise<ManifestEntry[]> {
  const { data } = await db
    .from('device_data_manifest')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('pinned_at', { ascending: false });

  return (data ?? []).map(mapRow);
}

/**
 * Find a manifest entry by data ID.
 */
export async function findManifestEntry(
  db: DatabaseAdapter,
  dataId: string,
): Promise<ManifestEntry | null> {
  const { data } = await db
    .from('device_data_manifest')
    .select('*')
    .eq('data_id', dataId)
    .maybeSingle();

  return data ? mapRow(data) : null;
}

/**
 * Search manifest by tags or title keywords.
 * Used for smart routing: find pinned data relevant to a task.
 */
export async function searchManifest(
  db: DatabaseAdapter,
  workspaceId: string,
  keywords: string[],
  opts?: { dataType?: PinnedDataType; limit?: number },
): Promise<ManifestEntry[]> {
  let query = db
    .from('device_data_manifest')
    .select('*')
    .eq('workspace_id', workspaceId);

  if (opts?.dataType) {
    query = query.eq('data_type', opts.dataType);
  }

  const { data } = await query;
  if (!data || (data as unknown[]).length === 0) return [];

  // Score by keyword overlap with tags and title
  const keywordSet = new Set(keywords.map(k => k.toLowerCase()));
  const entries = (data as unknown[]).map(row => {
    const entry = mapRow(row);
    const entryWords = [
      ...entry.tags.map(t => t.toLowerCase()),
      ...entry.title.toLowerCase().split(/\s+/),
    ];
    const score = entryWords.filter(w => keywordSet.has(w)).length;
    return { entry, score };
  });

  return entries
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts?.limit ?? 10)
    .map(e => e.entry);
}

/**
 * Get entries updated since a timestamp (for sync).
 */
export async function getManifestForSync(
  db: DatabaseAdapter,
  workspaceId: string,
  since?: string | null,
): Promise<ManifestEntry[]> {
  let query = db
    .from('device_data_manifest')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (since) {
    query = query.gt('created_at', since);
  }

  const { data } = await query;
  return (data ?? []).map(mapRow);
}

/**
 * Record that a manifest entry was fetched by a remote device.
 */
export async function recordFetch(
  db: DatabaseAdapter,
  dataId: string,
): Promise<void> {
  const now = new Date().toISOString();
  // Increment fetch count — use a simple update since SQLite doesn't have atomic increment
  const { data: entry } = await db
    .from('device_data_manifest')
    .select('fetch_count')
    .eq('data_id', dataId)
    .maybeSingle();

  if (!entry) return;

  const currentCount = (entry as { fetch_count: number }).fetch_count;
  await db.from('device_data_manifest')
    .update({
      last_fetched_at: now,
      fetch_count: currentCount + 1,
    })
    .eq('data_id', dataId);
}

// ============================================================================
// HELPERS
// ============================================================================

function dataTypeToTable(dataType: PinnedDataType): string | null {
  switch (dataType) {
    case 'memory': return 'agent_workforce_agent_memory';
    case 'conversation': return 'orchestrator_conversations';
    case 'knowledge_doc': return 'agent_workforce_knowledge_documents';
    default: return null; // 'file' and 'credential' don't have standard tables
  }
}

function mapRow(row: unknown): ManifestEntry {
  const r = row as Record<string, unknown>;
  const tags = typeof r.tags === 'string' ? JSON.parse(r.tags as string) : (r.tags ?? []);
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    deviceId: r.device_id as string,
    dataType: r.data_type as PinnedDataType,
    dataId: r.data_id as string,
    title: r.title as string,
    tags: tags as string[],
    sizeBytes: r.size_bytes as number,
    accessPolicy: r.access_policy as AccessPolicy,
    requiresApproval: Boolean(r.requires_approval),
    ownerUserId: r.owner_user_id as string | null,
    pinnedAt: r.pinned_at as string,
    lastFetchedAt: r.last_fetched_at as string | null,
    fetchCount: r.fetch_count as number,
  };
}
