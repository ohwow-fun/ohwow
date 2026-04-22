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
import {
  getEternalState,
  loadEternalSpec,
  saveEternalSpec,
  DEFAULT_ETERNAL_SPEC,
} from '../../eternal/index.js';
import type { EternalSpec, EscalationRule } from '../../eternal/index.js';

export function createAutonomyStatusRouter(db: DatabaseAdapter, dataDir?: string): Router {
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

  router.get('/api/eternal/state', async (req, res) => {
    try {
      const state = await getEternalState(db);
      res.json({ data: state });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  router.get('/api/eternal/config', (req, res) => {
    try {
      const spec = dataDir ? loadEternalSpec(dataDir) : DEFAULT_ETERNAL_SPEC;
      res.json({
        data: {
          escalationMap: spec.escalationMap,
          inactivityProtocol: spec.inactivityProtocol,
          trustee: spec.trustee ?? null,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.put('/api/eternal/config', async (req, res) => {
    if (!dataDir) {
      res.status(503).json({ error: 'Config directory unavailable' });
      return;
    }
    try {
      const body = req.body as Partial<{ escalationMap: unknown; inactivityProtocol: unknown }>;

      // Validate escalationMap if present
      if (body.escalationMap !== undefined) {
        if (!Array.isArray(body.escalationMap)) {
          res.status(400).json({ error: 'escalationMap must be an array' });
          return;
        }
        for (const rule of body.escalationMap as unknown[]) {
          if (
            typeof rule !== 'object' ||
            rule === null ||
            typeof (rule as Record<string, unknown>).decisionType !== 'string' ||
            typeof (rule as Record<string, unknown>).requiresTrustee !== 'boolean'
          ) {
            res.status(400).json({ error: 'Each rule requires decisionType (string) and requiresTrustee (boolean)' });
            return;
          }
        }
      }

      const patch: Partial<EternalSpec> = {};
      if (body.escalationMap !== undefined) patch.escalationMap = body.escalationMap as EscalationRule[];
      if (body.inactivityProtocol !== undefined) {
        const current = loadEternalSpec(dataDir);
        patch.inactivityProtocol = {
          ...current.inactivityProtocol,
          ...(body.inactivityProtocol as object),
        };
      }

      saveEternalSpec(dataDir, patch);
      const updated = loadEternalSpec(dataDir);
      res.json({ data: { escalationMap: updated.escalationMap, inactivityProtocol: updated.inactivityProtocol } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
