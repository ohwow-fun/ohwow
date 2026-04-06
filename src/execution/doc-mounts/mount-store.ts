/**
 * Mount Store — SQLite Persistence for Doc Mounts
 *
 * CRUD operations for doc_mounts and doc_mount_pages tables.
 * Uses the DatabaseAdapter interface for compatibility with both
 * SQLite (local) and Supabase (cloud) backends.
 */

import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { DocMount, DocMountPage, DocMountRow, DocMountPageRow, CrawledPage } from './types.js';
import { mapMountRow, mapPageRow } from './types.js';

// ============================================================================
// MOUNT OPERATIONS
// ============================================================================

export async function createMount(
  db: DatabaseAdapter,
  mount: {
    id: string;
    workspaceId: string;
    url: string;
    domain: string;
    namespace: string;
    mountPath: string;
    ttlDays: number;
  },
): Promise<DocMount> {
  const { data, error } = await db
    .from('doc_mounts')
    .insert({
      id: mount.id,
      workspace_id: mount.workspaceId,
      url: mount.url,
      domain: mount.domain,
      namespace: mount.namespace,
      mount_path: mount.mountPath,
      status: 'pending',
      ttl_days: mount.ttlDays,
    })
    .select('*')
    .single();

  if (error) throw new Error(`Couldn't create doc mount: ${error.message}`);
  return mapMountRow(data as unknown as DocMountRow);
}

export async function getMount(db: DatabaseAdapter, mountId: string): Promise<DocMount | null> {
  const { data, error } = await db
    .from('doc_mounts')
    .select('*')
    .eq('id', mountId)
    .single();

  if (error || !data) return null;
  return mapMountRow(data as unknown as DocMountRow);
}

export async function getMountByUrl(
  db: DatabaseAdapter,
  url: string,
  workspaceId: string,
): Promise<DocMount | null> {
  const { data, error } = await db
    .from('doc_mounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('url', url)
    .single();

  if (error || !data) return null;
  return mapMountRow(data as unknown as DocMountRow);
}

export async function getMountByNamespace(
  db: DatabaseAdapter,
  namespace: string,
  workspaceId: string,
): Promise<DocMount | null> {
  const { data, error } = await db
    .from('doc_mounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('namespace', namespace)
    .single();

  if (error || !data) return null;
  return mapMountRow(data as unknown as DocMountRow);
}

export async function listMounts(db: DatabaseAdapter, workspaceId: string): Promise<DocMount[]> {
  const { data, error } = await db
    .from('doc_mounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Couldn't list doc mounts: ${error.message}`);
  return (data || []).map((row) => mapMountRow(row as unknown as DocMountRow));
}

export async function updateMountStatus(
  db: DatabaseAdapter,
  mountId: string,
  update: {
    status: string;
    crawlError?: string | null;
    pageCount?: number;
    totalSizeBytes?: number;
    crawledAt?: string;
    expiresAt?: string;
  },
): Promise<void> {
  const row: Record<string, unknown> = {
    status: update.status,
    updated_at: new Date().toISOString(),
  };
  if (update.crawlError !== undefined) row.crawl_error = update.crawlError;
  if (update.pageCount !== undefined) row.page_count = update.pageCount;
  if (update.totalSizeBytes !== undefined) row.total_size_bytes = update.totalSizeBytes;
  if (update.crawledAt !== undefined) row.crawled_at = update.crawledAt;
  if (update.expiresAt !== undefined) row.expires_at = update.expiresAt;

  const { error } = await db
    .from('doc_mounts')
    .update(row)
    .eq('id', mountId);

  if (error) throw new Error(`Couldn't update doc mount: ${error.message}`);
}

export async function deleteMount(db: DatabaseAdapter, mountId: string): Promise<void> {
  // Pages cascade-delete via FK
  const { error } = await db
    .from('doc_mounts')
    .delete()
    .eq('id', mountId);

  if (error) throw new Error(`Couldn't delete doc mount: ${error.message}`);
}

// ============================================================================
// PAGE OPERATIONS
// ============================================================================

export async function upsertPage(
  db: DatabaseAdapter,
  page: {
    id: string;
    mountId: string;
    sourceUrl: string;
    filePath: string;
    content: string;
    contentHash: string;
    tokenCount: number;
    byteSize: number;
  },
): Promise<void> {
  // Try insert first; if conflict on (mount_id, file_path), update
  const { error: insertError } = await db
    .from('doc_mount_pages')
    .insert({
      id: page.id,
      mount_id: page.mountId,
      source_url: page.sourceUrl,
      file_path: page.filePath,
      content: page.content,
      content_hash: page.contentHash,
      token_count: page.tokenCount,
      byte_size: page.byteSize,
    });

  if (insertError) {
    // Likely unique constraint violation — update instead
    const { error: updateError } = await db
      .from('doc_mount_pages')
      .update({
        content: page.content,
        content_hash: page.contentHash,
        token_count: page.tokenCount,
        byte_size: page.byteSize,
        source_url: page.sourceUrl,
        crawled_at: new Date().toISOString(),
      })
      .eq('mount_id', page.mountId)
      .eq('file_path', page.filePath);

    if (updateError) throw new Error(`Couldn't upsert doc page: ${updateError.message}`);
  }
}

export async function listPages(db: DatabaseAdapter, mountId: string): Promise<DocMountPage[]> {
  const { data, error } = await db
    .from('doc_mount_pages')
    .select('*')
    .eq('mount_id', mountId)
    .order('file_path', { ascending: true });

  if (error) throw new Error(`Couldn't list doc pages: ${error.message}`);
  return (data || []).map((row) => mapPageRow(row as unknown as DocMountPageRow));
}

export async function getPage(
  db: DatabaseAdapter,
  mountId: string,
  filePath: string,
): Promise<DocMountPage | null> {
  const { data, error } = await db
    .from('doc_mount_pages')
    .select('*')
    .eq('mount_id', mountId)
    .eq('file_path', filePath)
    .single();

  if (error || !data) return null;
  return mapPageRow(data as unknown as DocMountPageRow);
}

export async function deletePages(db: DatabaseAdapter, mountId: string): Promise<void> {
  const { error } = await db
    .from('doc_mount_pages')
    .delete()
    .eq('mount_id', mountId);

  if (error) throw new Error(`Couldn't delete doc pages: ${error.message}`);
}
