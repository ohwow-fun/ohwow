/**
 * Analytics Routes
 * Website analytics snapshots (integration point for GA, Plausible, etc.)
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createAnalyticsRouter(
  db: DatabaseAdapter,
  _eventBus: TypedEventBus<RuntimeEvents>,
): Router {
  const router = Router();

  router.get('/api/analytics', async (req, res) => {
    try {
      const { workspaceId } = req;
      const limit = parseInt(req.query.limit as string || '20', 10);

      let query = db.from('analytics_snapshots').select('*').eq('workspace_id', workspaceId);
      if (req.query.period_start) query = query.gte('period_start', req.query.period_start as string);
      if (req.query.period_end) query = query.lte('period_end', req.query.period_end as string);

      const { data, error } = await query.order('period_start', { ascending: false }).limit(limit);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/analytics', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { period_start, period_end, source, pageviews, unique_visitors, sessions, avg_session_duration_secs, bounce_rate, top_pages, top_referrers } = req.body;
      if (!period_start || !period_end) {
        res.status(400).json({ error: 'period_start and period_end are required' });
        return;
      }

      const id = crypto.randomUUID();
      const { error } = await db.from('analytics_snapshots').insert({
        id, workspace_id: workspaceId,
        period_start, period_end,
        source: source || 'manual',
        pageviews: pageviews ?? null,
        unique_visitors: unique_visitors ?? null,
        sessions: sessions ?? null,
        avg_session_duration_secs: avg_session_duration_secs ?? null,
        bounce_rate: bounce_rate ?? null,
        top_pages: top_pages ? JSON.stringify(top_pages) : '[]',
        top_referrers: top_referrers ? JSON.stringify(top_referrers) : '[]',
      });
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('analytics_snapshots').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.get('/api/analytics/summary', async (req, res) => {
    try {
      const { workspaceId } = req;
      // Get latest snapshot
      const { data: latest } = await db.from('analytics_snapshots')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('period_start', { ascending: false })
        .limit(1);

      if (!latest || latest.length === 0) {
        res.json({ data: null });
        return;
      }

      res.json({ data: latest[0] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
