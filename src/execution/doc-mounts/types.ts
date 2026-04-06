/**
 * Doc Mounts — Type Definitions
 * Types for mounting documentation sites as browsable filesystems.
 */

// ============================================================================
// STATUS & CONFIG
// ============================================================================

export type DocMountStatus = 'pending' | 'crawling' | 'ready' | 'failed' | 'stale';

export interface CrawlOptions {
  /** Max pages to crawl (default: 500, max: 2000) */
  maxPages?: number;
  /** Max BFS depth when spidering (default: 3) */
  maxDepth?: number;
  /** Days before re-crawling (default: 7) */
  ttlDays?: number;
  /** Timeout per page fetch in seconds (default: 30) */
  pageTimeout?: number;
}

// ============================================================================
// MOUNT & PAGE DATA
// ============================================================================

export interface DocMount {
  id: string;
  workspaceId: string;
  url: string;
  domain: string;
  namespace: string;
  mountPath: string;
  pageCount: number;
  totalSizeBytes: number;
  status: DocMountStatus;
  crawlError: string | null;
  ttlDays: number;
  crawledAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocMountPage {
  id: string;
  mountId: string;
  sourceUrl: string;
  filePath: string;
  content: string;
  contentHash: string;
  tokenCount: number;
  byteSize: number;
  crawledAt: string;
}

// ============================================================================
// DB ROW SHAPES
// ============================================================================

export interface DocMountRow {
  id: string;
  workspace_id: string;
  url: string;
  domain: string;
  namespace: string;
  mount_path: string;
  page_count: number;
  total_size_bytes: number;
  status: DocMountStatus;
  crawl_error: string | null;
  ttl_days: number;
  crawled_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocMountPageRow {
  id: string;
  mount_id: string;
  source_url: string;
  file_path: string;
  content: string;
  content_hash: string;
  token_count: number;
  byte_size: number;
  crawled_at: string;
}

// ============================================================================
// MAPPERS
// ============================================================================

export function mapMountRow(row: DocMountRow): DocMount {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    url: row.url,
    domain: row.domain,
    namespace: row.namespace,
    mountPath: row.mount_path,
    pageCount: row.page_count,
    totalSizeBytes: row.total_size_bytes,
    status: row.status,
    crawlError: row.crawl_error,
    ttlDays: row.ttl_days,
    crawledAt: row.crawled_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapPageRow(row: DocMountPageRow): DocMountPage {
  return {
    id: row.id,
    mountId: row.mount_id,
    sourceUrl: row.source_url,
    filePath: row.file_path,
    content: row.content,
    contentHash: row.content_hash,
    tokenCount: row.token_count,
    byteSize: row.byte_size,
    crawledAt: row.crawled_at,
  };
}

// ============================================================================
// CRAWL EVENTS (yielded by crawler)
// ============================================================================

export interface CrawledPage {
  sourceUrl: string;
  filePath: string;
  content: string;
  contentHash: string;
  tokenCount: number;
  byteSize: number;
}
