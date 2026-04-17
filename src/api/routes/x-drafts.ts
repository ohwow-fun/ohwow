/**
 * X Post Drafts Route
 *
 * GET    /api/x-drafts                List drafts for the daemon's workspace.
 * POST   /api/x-drafts/:id/approve    Flip status → 'approved', stamp approved_at.
 * POST   /api/x-drafts/:id/reject     Flip status → 'rejected', stamp rejected_at.
 *
 * Backs the ohwow_list_x_drafts / ohwow_approve_x_draft /
 * ohwow_reject_x_draft MCP tools. Rows are drafted by the hourly
 * XDraftDistillerScheduler from novel market-radar findings.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import {
  listDrafts,
  setDraftStatus,
  type XDraftStatus,
} from '../../scheduling/x-draft-store.js';

function asStatus(raw: unknown): XDraftStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  const valid: XDraftStatus[] = ['pending', 'approved', 'rejected'];
  return valid.includes(raw as XDraftStatus) ? (raw as XDraftStatus) : undefined;
}

export function createXDraftsRouter(db: DatabaseAdapter, workspaceId: string): Router {
  const router = Router();

  router.get('/api/x-drafts', async (req, res) => {
    try {
      const status = asStatus(req.query.status);
      const limitRaw =
        typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
      const limit = limitRaw && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
      const drafts = await listDrafts(db, workspaceId, { status, limit });
      res.json({ data: drafts, count: drafts.length, limit });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/x-drafts/:id/approve', async (req, res) => {
    try {
      const { id } = req.params;
      const row = await setDraftStatus(db, workspaceId, id, 'approved');
      if (!row) {
        res.status(404).json({ error: 'draft not found' });
        return;
      }
      res.json({ data: row });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/x-drafts/:id/reject', async (req, res) => {
    try {
      const { id } = req.params;
      const row = await setDraftStatus(db, workspaceId, id, 'rejected');
      if (!row) {
        res.status(404).json({ error: 'draft not found' });
        return;
      }
      res.json({ data: row });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
