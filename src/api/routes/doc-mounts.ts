/**
 * Doc Mount Peer Routes
 *
 * Mesh-facing API for sharing doc mount data between peer devices.
 * Authenticated via X-Peer-Token (same as RAG query route).
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { logger } from '../../lib/logger.js';

/**
 * Public doc mount routes for mesh peers.
 * Must be mounted BEFORE the auth middleware (uses X-Peer-Token auth).
 */
export function createDocMountPeerRouter(db: DatabaseAdapter, workspaceId: string): Router {
  const router = Router();

  /** Authenticate peer via X-Peer-Token */
  async function authenticatePeer(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const { data: peer } = await db
      .from('workspace_peers')
      .select('id')
      .eq('our_token', token)
      .eq('status', 'connected')
      .single();
    return !!peer;
  }

  // List doc mounts available on this device
  router.get('/api/peers/doc-mounts', async (req, res) => {
    const peerToken = req.headers['x-peer-token'] as string | undefined;
    if (!(await authenticatePeer(peerToken))) {
      res.status(401).json({ error: 'Invalid peer token' });
      return;
    }

    try {
      const { data: mounts } = await db
        .from('doc_mounts')
        .select('id, url, domain, namespace, page_count, status, crawled_at')
        .eq('workspace_id', workspaceId)
        .eq('status', 'ready');

      res.json({ mounts: mounts || [] });
    } catch (err) {
      logger.error({ err }, '[doc-mount-peer] List failed');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Get directory tree of a specific mount
  router.get('/api/peers/doc-mounts/:mountId/tree', async (req, res) => {
    const peerToken = req.headers['x-peer-token'] as string | undefined;
    if (!(await authenticatePeer(peerToken))) {
      res.status(401).json({ error: 'Invalid peer token' });
      return;
    }

    try {
      const { data: pages } = await db
        .from('doc_mount_pages')
        .select('file_path')
        .eq('mount_id', req.params.mountId)
        .order('file_path', { ascending: true });

      res.json({ tree: (pages || []).map((p) => (p as { file_path: string }).file_path) });
    } catch (err) {
      logger.error({ err }, '[doc-mount-peer] Tree failed');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Read a specific page from a mount
  router.get('/api/peers/doc-mounts/:mountId/read', async (req, res) => {
    const peerToken = req.headers['x-peer-token'] as string | undefined;
    if (!(await authenticatePeer(peerToken))) {
      res.status(401).json({ error: 'Invalid peer token' });
      return;
    }

    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path query param is required' });
      return;
    }

    try {
      const { data: page } = await db
        .from('doc_mount_pages')
        .select('file_path, content, source_url, token_count')
        .eq('mount_id', req.params.mountId)
        .eq('file_path', filePath)
        .single();

      if (!page) {
        res.status(404).json({ error: 'Page not found' });
        return;
      }

      res.json(page);
    } catch (err) {
      logger.error({ err }, '[doc-mount-peer] Read failed');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Search across a mount's pages (text search)
  router.post('/api/peers/doc-mounts/:mountId/search', async (req, res) => {
    const peerToken = req.headers['x-peer-token'] as string | undefined;
    if (!(await authenticatePeer(peerToken))) {
      res.status(401).json({ error: 'Invalid peer token' });
      return;
    }

    const { query, max_results } = req.body as { query?: string; max_results?: number };
    if (!query) {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    try {
      // Simple in-memory search: fetch all pages and filter
      const { data: pages } = await db
        .from('doc_mount_pages')
        .select('file_path, content')
        .eq('mount_id', req.params.mountId);

      if (!pages || pages.length === 0) {
        res.json({ results: [] });
        return;
      }

      const lowerQuery = query.toLowerCase();
      const limit = Math.min(max_results || 20, 50);
      const results: Array<{ filePath: string; matchLine: string }> = [];

      for (const page of pages as Array<{ file_path: string; content: string }>) {
        if (results.length >= limit) break;
        if (page.content.toLowerCase().includes(lowerQuery)) {
          const lines = page.content.split('\n');
          const matchLine = lines.find((l) => l.toLowerCase().includes(lowerQuery)) || '';
          results.push({
            filePath: page.file_path,
            matchLine: matchLine.trim().slice(0, 200),
          });
        }
      }

      res.json({ results });
    } catch (err) {
      logger.error({ err }, '[doc-mount-peer] Search failed');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
