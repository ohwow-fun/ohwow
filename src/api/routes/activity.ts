/**
 * Activity Routes
 * GET /api/activity — Recent activity entries
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createActivityRouter(db: DatabaseAdapter): Router {
  const router = Router();

  router.get('/api/activity', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { limit = '50' } = req.query;

      const { data, error } = await db.from('agent_workforce_activity')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(parseInt(limit as string, 10));

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
