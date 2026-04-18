/**
 * Founder Inbox Route (autonomy arc Phase 4).
 *
 * GET /api/founder-inbox?status=open|answered|resolved|expired
 *   List rows in the active workspace, default status='open'. Sorted
 *   newest-asked first.
 *
 * POST /api/founder-inbox/:id/answer  body { answer: string }
 *   Record an answer. The Director's next tick promotes the row to
 *   `resolved` and feeds the answer back to the picker.
 *
 * Local-only this phase. Cloud sync (mirror to dashboard) is later work.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import {
  answerFounderQuestion,
  listFounderInboxByStatus,
  loadFounderQuestion,
  type FounderInboxStatus,
} from '../../autonomy/director-persistence.js';

const VALID_STATUSES: FounderInboxStatus[] = [
  'open',
  'answered',
  'resolved',
  'expired',
];

function asStatus(raw: unknown): FounderInboxStatus | null {
  if (typeof raw !== 'string') return null;
  return VALID_STATUSES.includes(raw as FounderInboxStatus)
    ? (raw as FounderInboxStatus)
    : null;
}

export function createFounderInboxRouter(db: DatabaseAdapter): Router {
  const router = Router();

  router.get('/api/founder-inbox', async (req, res) => {
    try {
      const workspaceId = req.workspaceId ?? 'local';
      const statusRaw = req.query.status;
      const status = statusRaw !== undefined ? asStatus(statusRaw) : 'open';
      if (statusRaw !== undefined && status === null) {
        res.status(400).json({
          error: `Invalid status. One of: ${VALID_STATUSES.join(', ')}.`,
        });
        return;
      }
      const rows = await listFounderInboxByStatus(
        db,
        workspaceId,
        status ?? 'open',
      );
      res.json({ data: rows, count: rows.length });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  router.post('/api/founder-inbox/:id/answer', async (req, res) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'Missing inbox id.' });
        return;
      }
      const body = req.body as { answer?: unknown } | undefined;
      const answer = body && typeof body.answer === 'string' ? body.answer : '';
      if (!answer.trim()) {
        res.status(400).json({ error: "Give the answer some text first." });
        return;
      }

      const existing = await loadFounderQuestion(db, id);
      if (!existing) {
        res.status(404).json({ error: `No founder-inbox row with id ${id}.` });
        return;
      }

      await answerFounderQuestion(db, {
        id,
        answer,
        answered_at: new Date().toISOString(),
      });
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  return router;
}
