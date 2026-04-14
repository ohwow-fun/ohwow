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
      const { activityType, limit = '50', offset = '0' } = req.query;
      const limNum = Math.max(1, Math.min(200, parseInt(limit as string, 10) || 50));
      const offNum = Math.max(0, parseInt(offset as string, 10) || 0);

      let countQuery = db.from('agent_workforce_activity')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId);
      if (activityType) countQuery = countQuery.eq('activity_type', activityType as string);
      const { count: total } = await countQuery;

      let query = db.from('agent_workforce_activity')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .range(offNum, offNum + limNum - 1);
      if (activityType) query = query.eq('activity_type', activityType as string);

      const { data, error } = await query;
      if (error) { res.status(500).json({ error: error.message }); return; }

      // Always surface the full set of activity types with counts so the UI's
      // filter bar reflects what is actually in the DB, not a hardcoded guess.
      const typeRows = (await db.from('agent_workforce_activity')
        .select('activity_type')
        .eq('workspace_id', workspaceId)).data as Array<{ activity_type: string }> | null;
      const typeCountMap = new Map<string, number>();
      for (const row of typeRows ?? []) {
        typeCountMap.set(row.activity_type, (typeCountMap.get(row.activity_type) ?? 0) + 1);
      }
      const types = [...typeCountMap.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count);

      // SQLite's default datetime('now') emits "YYYY-MM-DD HH:MM:SS" with no
      // timezone suffix; JS parses that as local time, which on a UTC-5 host
      // shifts every event five hours into the future and collapses every
      // "time ago" label to "just now". Normalize to ISO-8601 UTC on read so
      // every existing row renders correctly without a backfill migration.
      const normalized = (data ?? []).map((row: Record<string, unknown>) => {
        const ts = row.created_at as string | null;
        if (ts && typeof ts === 'string' && !ts.endsWith('Z') && !/[+-]\d\d:?\d\d$/.test(ts)) {
          return { ...row, created_at: ts.replace(' ', 'T') + 'Z' };
        }
        return row;
      });

      res.json({ data: normalized, total: total ?? 0, limit: limNum, offset: offNum, types });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
