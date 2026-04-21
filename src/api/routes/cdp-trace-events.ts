/**
 * CDP Trace Events Route
 *
 * GET /api/cdp-trace-events
 *   List rows from cdp_trace_events. Supports filtering by action,
 *   profile, owner, and since (ISO timestamp). Defaults to newest-first,
 *   capped at 50 rows.
 *
 * Backs the ohwow_list_cdp_events MCP tool. Rows are written by
 * insertCdpTraceEvent at every cdp:true log call site.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { CdpTraceEventRow } from '../../execution/browser/cdp-trace-store.js';

export function createCdpTraceEventsRouter(db: DatabaseAdapter, workspaceId: string): Router {
  const router = Router();

  router.get('/api/cdp-trace-events', async (req, res) => {
    try {
      const action = typeof req.query.action === 'string' ? req.query.action : undefined;
      const profile = typeof req.query.profile === 'string' ? req.query.profile : undefined;
      const owner = typeof req.query.owner === 'string' ? req.query.owner : undefined;
      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
      const limit = limitRaw && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

      let query = db
        .from<CdpTraceEventRow>('cdp_trace_events')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('ts', { ascending: false })
        .limit(limit);

      if (action) query = query.eq('action', action);
      if (profile) query = query.eq('profile', profile);
      if (owner) query = query.eq('owner', owner);
      if (since) query = query.gte('ts', since);

      const { data, error } = await query;

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      const rows = data ?? [];
      res.json({ data: rows, count: rows.length, limit });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
