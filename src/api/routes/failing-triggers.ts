/**
 * Failing Triggers Route
 *
 * GET /api/failing-triggers
 *   List every trigger whose consecutive_failures is at or above the
 *   watchdog threshold (default 3). This is the operator's "what
 *   scheduled things are silently miscarrying" query — the direct
 *   closure of the silent-cron failure mode that made the diary
 *   trigger invisible for 2+ weeks.
 *
 * Workspace-scoped via req.workspaceId. Returns an array of
 *   { id, name, consecutive_failures, last_succeeded_at, last_fired_at,
 *     trigger_type, enabled, last_error }
 * rows sorted by consecutive_failures DESC so the worst offenders
 * come first. Query supports ?threshold=N to override the default.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { TRIGGER_STUCK_THRESHOLD } from '../../triggers/trigger-watchdog.js';

interface FailingTriggerRow {
  id: string;
  name: string;
  consecutive_failures: number | null;
  last_succeeded_at: string | null;
  last_fired_at: string | null;
  trigger_type: string | null;
  enabled: number;
  last_error: string | null;
}

export function createFailingTriggersRouter(db: DatabaseAdapter): Router {
  const router = Router();

  router.get('/api/failing-triggers', async (req, res) => {
    try {
      const thresholdRaw = req.query.threshold as string | undefined;
      const threshold = thresholdRaw ? Math.max(1, parseInt(thresholdRaw, 10)) : TRIGGER_STUCK_THRESHOLD;

      // local_triggers has no workspace_id column — each daemon owns
      // exactly one workspace's trigger table, so "all rows here" is
      // already workspace-scoped by the daemon process boundary.
      const { data, error } = await db
        .from<FailingTriggerRow>('local_triggers')
        .select('id, name, consecutive_failures, last_succeeded_at, last_fired_at, trigger_type, enabled, last_error')
        .gte('consecutive_failures', threshold)
        .order('consecutive_failures', { ascending: false });

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      const rows = (data ?? []) as FailingTriggerRow[];
      res.json({
        data: rows.map((r) => ({
          id: r.id,
          name: r.name,
          consecutive_failures: r.consecutive_failures ?? 0,
          last_succeeded_at: r.last_succeeded_at,
          last_fired_at: r.last_fired_at,
          trigger_type: r.trigger_type,
          enabled: r.enabled === 1,
          last_error: r.last_error,
        })),
        threshold,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
