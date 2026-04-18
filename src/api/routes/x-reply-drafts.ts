/**
 * X / Threads Reply Drafts Route
 *
 * GET    /api/x-reply-drafts             List reply drafts (?platform=&status=&limit=).
 * POST   /api/x-reply-drafts/:id/approve Flip status → 'approved', stamp approved_at.
 * POST   /api/x-reply-drafts/:id/reject  Flip status → 'rejected', stamp rejected_at.
 *
 * Backs the ohwow_list_x_reply_drafts / ohwow_approve_x_reply_draft /
 * ohwow_reject_x_reply_draft MCP tools. Rows are drafted by the
 * X/Threads reply schedulers and consumed by the reply dispatchers.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import {
  listReplyDrafts,
  setReplyDraftStatus,
  type ReplyDraftPlatform,
  type ReplyDraftStatus,
} from '../../scheduling/x-reply-store.js';

function asPlatform(raw: unknown): ReplyDraftPlatform | undefined {
  if (raw === 'x' || raw === 'threads') return raw;
  return undefined;
}

function asStatus(raw: unknown): ReplyDraftStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  const valid: ReplyDraftStatus[] = ['pending', 'approved', 'rejected', 'applied', 'auto_applied'];
  return valid.includes(raw as ReplyDraftStatus) ? (raw as ReplyDraftStatus) : undefined;
}

export function createXReplyDraftsRouter(db: DatabaseAdapter, workspaceId: string): Router {
  const router = Router();

  router.get('/api/x-reply-drafts', async (req, res) => {
    try {
      const platform = asPlatform(req.query.platform);
      const status = asStatus(req.query.status);
      const limitRaw =
        typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
      const limit = limitRaw && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
      const drafts = await listReplyDrafts(db, workspaceId, { platform, status, limit });
      res.json({ data: drafts, count: drafts.length, limit });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/x-reply-drafts/:id/approve', async (req, res) => {
    try {
      const { id } = req.params;
      const row = await setReplyDraftStatus(db, workspaceId, id, 'approved');
      if (!row) {
        res.status(404).json({ error: 'draft not found' });
        return;
      }
      res.json({ data: row });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/x-reply-drafts/:id/reject', async (req, res) => {
    try {
      const { id } = req.params;
      const row = await setReplyDraftStatus(db, workspaceId, id, 'rejected');
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
