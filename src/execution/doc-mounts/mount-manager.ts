/**
 * Doc Mount Manager
 *
 * High-level orchestrator for doc mounts lifecycle:
 * crawl → store → materialize-to-disk.
 *
 * Handles caching, TTL-based re-crawl, and cleanup.
 */

import { randomUUID } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ScraplingService } from '../scrapling/index.js';
import type { DocMount, CrawlOptions, CrawledPage } from './types.js';
import { crawlDocSite } from './crawler.js';
import { normalizeUrlsToPaths, urlToNamespace, extractDomain } from './path-normalizer.js';
import * as store from './mount-store.js';
import { ingestMountToKnowledgeBase, removeKnowledgeForMount, type RagIngestOptions } from './rag-ingest.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_TTL_DAYS = 7;
const DOCS_BASE_DIR = path.join(os.homedir(), '.ohwow', 'docs');

// ============================================================================
// MANAGER
// ============================================================================

export interface DocMountManagerConfig {
  /** Ollama URL for embedding generation */
  ollamaUrl?: string;
  /** Embedding model name (e.g., nomic-embed-text) */
  embeddingModel?: string;
}

export class DocMountManager {
  private ragConfig: DocMountManagerConfig;

  constructor(
    private db: DatabaseAdapter,
    private scraplingService: ScraplingService,
    private dataDir?: string,
    ragConfig?: DocMountManagerConfig,
  ) {
    this.ragConfig = ragConfig ?? {};
  }

  /** Update RAG config (e.g., when Ollama becomes available) */
  setRagConfig(config: DocMountManagerConfig): void {
    this.ragConfig = { ...this.ragConfig, ...config };
  }

  /** Get the base directory for materialized docs */
  private getDocsDir(): string {
    return this.dataDir ? path.join(this.dataDir, 'docs') : DOCS_BASE_DIR;
  }

  /**
   * Mount a documentation site.
   * Crawls the site, stores pages in SQLite, and materializes to disk.
   * Returns the mount with status 'ready' on success.
   *
   * If the URL is already mounted and fresh, returns the existing mount.
   */
  async mount(url: string, workspaceId: string, options: CrawlOptions = {}): Promise<DocMount> {
    // Check for existing mount
    const existing = await store.getMountByUrl(this.db, url, workspaceId);
    if (existing) {
      if (existing.status === 'ready' && !this.isExpired(existing)) {
        logger.info({ url, namespace: existing.namespace }, '[doc-mount] Using cached mount');
        return existing;
      }
      // Stale or failed — re-crawl
      logger.info({ url, status: existing.status }, '[doc-mount] Re-crawling stale/failed mount');
      await store.deletePages(this.db, existing.id);
      await store.updateMountStatus(this.db, existing.id, { status: 'crawling', crawlError: null });
      return this.doCrawl(existing, options);
    }

    // Create new mount
    const namespace = urlToNamespace(url);
    const domain = extractDomain(url);
    const mountPath = path.join(this.getDocsDir(), namespace);
    const ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;

    let mount: DocMount;
    try {
      mount = await store.createMount(this.db, {
        id: randomUUID(),
        workspaceId,
        url,
        domain,
        namespace,
        mountPath,
        ttlDays,
      });
    } catch {
      // UNIQUE constraint race: another concurrent mount won — use theirs
      const raced = await store.getMountByUrl(this.db, url, workspaceId);
      if (raced) return raced;
      throw new Error(`Couldn't create doc mount for ${url}`);
    }

    await store.updateMountStatus(this.db, mount.id, { status: 'crawling' });

    return this.doCrawl({ ...mount, status: 'crawling' }, options);
  }

  /** Unmount a documentation site. Deletes DB records and disk files. */
  async unmount(mountId: string): Promise<void> {
    const mount = await store.getMount(this.db, mountId);
    if (!mount) return;

    // Remove knowledge base entries (keyed by namespace)
    try {
      const removed = await removeKnowledgeForMount(mount.namespace, this.db, mount.workspaceId);
      if (removed > 0) {
        logger.info({ removed }, '[doc-mount] Removed knowledge base entries');
      }
    } catch (err) {
      logger.warn({ err }, '[doc-mount] Knowledge cleanup failed, continuing unmount');
    }

    // Remove from disk
    if (mount.mountPath && fs.existsSync(mount.mountPath)) {
      fs.rmSync(mount.mountPath, { recursive: true, force: true });
      logger.info({ path: mount.mountPath }, '[doc-mount] Removed disk files');
    }

    // Remove from DB (pages cascade-delete)
    await store.deleteMount(this.db, mountId);
    logger.info({ url: mount.url, namespace: mount.namespace }, '[doc-mount] Unmounted');
  }

  /** Unmount by URL */
  async unmountByUrl(url: string, workspaceId: string): Promise<boolean> {
    const mount = await store.getMountByUrl(this.db, url, workspaceId);
    if (!mount) return false;
    await this.unmount(mount.id);
    return true;
  }

  /** List all mounts for a workspace */
  async listMounts(workspaceId: string): Promise<DocMount[]> {
    return store.listMounts(this.db, workspaceId);
  }

  /** Get a mount by ID */
  async getMount(mountId: string): Promise<DocMount | null> {
    return store.getMount(this.db, mountId);
  }

  /** Get a mount by URL */
  async getMountByUrl(url: string, workspaceId: string): Promise<DocMount | null> {
    return store.getMountByUrl(this.db, url, workspaceId);
  }

  /** Refresh a mount if it has expired */
  async refreshIfStale(mountId: string): Promise<DocMount> {
    const mount = await store.getMount(this.db, mountId);
    if (!mount) throw new Error(`Mount ${mountId} not found`);

    if (!this.isExpired(mount)) return mount;

    logger.info({ url: mount.url }, '[doc-mount] Refreshing stale mount');
    await store.deletePages(this.db, mount.id);
    await store.updateMountStatus(this.db, mount.id, { status: 'crawling', crawlError: null });
    return this.doCrawl({ ...mount, status: 'crawling' }, {});
  }

  /**
   * Materialize mount pages to disk.
   * Writes .md files preserving the normalized directory structure.
   * Returns the disk path.
   */
  async materializeToDisk(mount: DocMount): Promise<string> {
    const pages = await store.listPages(this.db, mount.id);
    const docsDir = mount.mountPath;

    // Ensure base directory exists
    fs.mkdirSync(docsDir, { recursive: true });

    let writtenCount = 0;
    const resolvedDocsDir = path.resolve(docsDir);
    for (const page of pages) {
      const filePath = path.resolve(docsDir, page.filePath.replace(/^\//, ''));

      // Path traversal guard: ensure resolved path stays within mount directory
      if (!filePath.startsWith(resolvedDocsDir + path.sep) && filePath !== resolvedDocsDir) {
        logger.warn({ filePath: page.filePath }, '[doc-mount] Skipping path traversal attempt');
        continue;
      }

      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, page.content, 'utf-8');
      writtenCount++;
    }

    logger.info({ path: docsDir, files: writtenCount }, '[doc-mount] Materialized to disk');
    return docsDir;
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  /** Execute the crawl, store pages, materialize, update status */
  private async doCrawl(mount: DocMount, options: CrawlOptions): Promise<DocMount> {
    try {
      // Crawl and collect all pages first (need all URLs for path normalization)
      const rawPages: CrawledPage[] = [];
      for await (const page of crawlDocSite(mount.url, this.scraplingService, options)) {
        rawPages.push(page);
      }

      if (rawPages.length === 0) {
        await store.updateMountStatus(this.db, mount.id, {
          status: 'failed',
          crawlError: 'No pages found. The site may be behind authentication or have no crawlable content.',
        });
        return { ...mount, status: 'failed', crawlError: 'No pages found' };
      }

      // Normalize all URLs to file paths
      const urlToPath = normalizeUrlsToPaths(
        rawPages.map((p) => p.sourceUrl),
        mount.url,
      );

      // Store pages in DB
      let totalBytes = 0;
      for (const page of rawPages) {
        const filePath = urlToPath.get(page.sourceUrl) || `/${randomUUID()}.md`;
        await store.upsertPage(this.db, {
          id: randomUUID(),
          mountId: mount.id,
          sourceUrl: page.sourceUrl,
          filePath,
          content: page.content,
          contentHash: page.contentHash,
          tokenCount: page.tokenCount,
          byteSize: page.byteSize,
        });
        totalBytes += page.byteSize;
      }

      // Materialize to disk
      const updatedMount: DocMount = {
        ...mount,
        pageCount: rawPages.length,
        totalSizeBytes: totalBytes,
        status: 'ready',
        crawlError: null,
        crawledAt: new Date().toISOString(),
        expiresAt: this.computeExpiry(mount.ttlDays),
      };

      await store.updateMountStatus(this.db, mount.id, {
        status: 'ready',
        crawlError: null,
        pageCount: rawPages.length,
        totalSizeBytes: totalBytes,
        crawledAt: updatedMount.crawledAt!,
        expiresAt: updatedMount.expiresAt!,
      });

      await this.materializeToDisk(updatedMount);

      // RAG ingestion: chunk + embed into knowledge base (best-effort)
      try {
        const storedPages = await store.listPages(this.db, mount.id);
        await ingestMountToKnowledgeBase(updatedMount, storedPages, {
          db: this.db,
          workspaceId: mount.workspaceId,
          ollamaUrl: this.ragConfig.ollamaUrl,
          embeddingModel: this.ragConfig.embeddingModel,
        });
      } catch (err) {
        logger.warn({ err, url: mount.url }, '[doc-mount] RAG ingestion failed, mount still usable');
      }

      logger.info(
        { url: mount.url, pages: rawPages.length, bytes: totalBytes },
        '[doc-mount] Mount ready',
      );

      return updatedMount;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Crawl failed';
      await store.updateMountStatus(this.db, mount.id, {
        status: 'failed',
        crawlError: msg,
      });
      logger.error({ err, url: mount.url }, '[doc-mount] Crawl failed');
      return { ...mount, status: 'failed', crawlError: msg };
    }
  }

  /** Check if a mount has expired based on its TTL */
  private isExpired(mount: DocMount): boolean {
    if (!mount.expiresAt) return true;
    return new Date(mount.expiresAt).getTime() < Date.now();
  }

  /** Compute expiry date from now + ttlDays */
  private computeExpiry(ttlDays: number): string {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + ttlDays);
    return expiry.toISOString();
  }
}
