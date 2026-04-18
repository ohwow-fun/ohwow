/**
 * Autonomy Status Route (Phase 6.7 Deliverable C).
 *
 * GET /api/autonomy/status
 *   Snapshot of the autonomy stack: flag state, open arcs (with budget
 *   and elapsed time), recent closed arcs, recent phase reports, inbox
 *   counts, pulse-side counts. Cheap reads only.
 *
 * GET /api/autonomy/dry-run?limit=N
 *   What the conductor's ranker WOULD return if a tick fired right now.
 *   Read-only — never writes to any table, never opens an arc.
 *
 * Local-only this phase. Mirrors the founder-inbox route shape.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { dryRunRanker } from '../../autonomy/dry-run.js';
import { getConductorState } from '../../autonomy/state.js';

export function createAutonomyStatusRouter(db: DatabaseAdapter): Router {
  const router = Router();

  router.get('/api/autonomy/status', async (req, res) => {
    try {
      const workspaceId = req.workspaceId ?? 'local';
      const snapshot = await getConductorState(db, workspaceId);
      res.json({ data: snapshot });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  router.get('/api/autonomy/dry-run', async (req, res) => {
    try {
      const workspaceId = req.workspaceId ?? 'local';
      const limitRaw = req.query.limit;
      let limit = 10;
      if (typeof limitRaw === 'string') {
        const parsed = Number.parseInt(limitRaw, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          limit = Math.min(parsed, 100);
        }
      }
      const snapshot = await dryRunRanker(db, workspaceId, { limit });
      res.json({ data: snapshot });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  return router;
}
