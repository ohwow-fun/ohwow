/**
 * Time Tracking Routes
 * CRUD for time entries and aggregate reports.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createTimeTrackingRouter(
  db: DatabaseAdapter,
  _eventBus: TypedEventBus<RuntimeEvents>,
): Router {
  const router = Router();

  router.get('/api/time-entries', async (req, res) => {
    try {
      const { workspaceId } = req;
      const limit = parseInt(req.query.limit as string || '50', 10);

      let query = db.from('time_entries').select('*').eq('workspace_id', workspaceId);
      if (req.query.team_member_id) query = query.eq('team_member_id', req.query.team_member_id as string);
      if (req.query.project_id) query = query.eq('project_id', req.query.project_id as string);
      if (req.query.after) query = query.gte('entry_date', req.query.after as string);
      if (req.query.before) query = query.lte('entry_date', req.query.before as string);

      const { data, error } = await query.order('entry_date', { ascending: false }).limit(limit);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/time-entries', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { team_member_id, duration_minutes, entry_date, project_id, deal_id, ticket_id, description, start_time, end_time, billable, hourly_rate_cents, tags } = req.body;
      if (!team_member_id || !duration_minutes || !entry_date) {
        res.status(400).json({ error: 'team_member_id, duration_minutes, and entry_date are required' });
        return;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await db.from('time_entries').insert({
        id, workspace_id: workspaceId,
        team_member_id, duration_minutes, entry_date,
        project_id: project_id || null,
        deal_id: deal_id || null,
        ticket_id: ticket_id || null,
        description: description || null,
        start_time: start_time || null,
        end_time: end_time || null,
        billable: billable === false ? 0 : 1,
        hourly_rate_cents: hourly_rate_cents ?? null,
        tags: tags ? JSON.stringify(tags) : '[]',
        created_at: now, updated_at: now,
      });
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('time_entries').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.patch('/api/time-entries/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      delete updates.id; delete updates.workspace_id;
      if (updates.tags && typeof updates.tags !== 'string') updates.tags = JSON.stringify(updates.tags);
      if (updates.billable !== undefined) updates.billable = updates.billable ? 1 : 0;

      const { error } = await db.from('time_entries')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('time_entries').select('*').eq('id', req.params.id).single();
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.delete('/api/time-entries/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('time_entries')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Time Report ──────────────────────────────────────────────────

  router.get('/api/time-entries/report', async (req, res) => {
    try {
      const { workspaceId } = req;
      const groupBy = (req.query.group_by as string) || 'person';
      const after = req.query.after as string;
      const before = req.query.before as string;

      let query = db.from('time_entries').select('*').eq('workspace_id', workspaceId);
      if (after) query = query.gte('entry_date', after);
      if (before) query = query.lte('entry_date', before);
      if (req.query.team_member_id) query = query.eq('team_member_id', req.query.team_member_id as string);
      if (req.query.project_id) query = query.eq('project_id', req.query.project_id as string);

      const { data: entries } = await query.order('entry_date', { ascending: false });
      const all = (entries || []) as Array<Record<string, unknown>>;

      const totalMinutes = all.reduce((sum, e) => sum + (e.duration_minutes as number), 0);
      const billableMinutes = all.filter(e => (e.billable as number) === 1)
        .reduce((sum, e) => sum + (e.duration_minutes as number), 0);

      // Group
      const groups: Record<string, { key: string; total_minutes: number; billable_minutes: number; entry_count: number }> = {};
      for (const entry of all) {
        let key: string;
        switch (groupBy) {
          case 'project': key = (entry.project_id as string) || 'no_project'; break;
          case 'date': key = entry.entry_date as string; break;
          default: key = entry.team_member_id as string; break;
        }
        if (!groups[key]) groups[key] = { key, total_minutes: 0, billable_minutes: 0, entry_count: 0 };
        groups[key].total_minutes += entry.duration_minutes as number;
        if ((entry.billable as number) === 1) groups[key].billable_minutes += entry.duration_minutes as number;
        groups[key].entry_count++;
      }

      // Resolve names for person/project grouping
      if (groupBy === 'person') {
        const memberIds = [...new Set(all.map(e => e.team_member_id as string))];
        if (memberIds.length > 0) {
          const { data: members } = await db.from('agent_workforce_team_members')
            .select('id, name')
            .eq('workspace_id', workspaceId);
          const nameMap = new Map((members || []).map(m => [(m as { id: string }).id, (m as { name: string }).name]));
          for (const g of Object.values(groups)) {
            if (nameMap.has(g.key)) g.key = nameMap.get(g.key)!;
          }
        }
      } else if (groupBy === 'project') {
        const projectIds = [...new Set(all.map(e => e.project_id as string).filter(Boolean))];
        if (projectIds.length > 0) {
          const { data: projects } = await db.from('agent_workforce_projects')
            .select('id, name')
            .eq('workspace_id', workspaceId);
          const nameMap = new Map((projects || []).map(p => [(p as { id: string }).id, (p as { name: string }).name]));
          for (const g of Object.values(groups)) {
            if (nameMap.has(g.key)) g.key = nameMap.get(g.key)!;
          }
        }
      }

      res.json({
        data: {
          group_by: groupBy,
          total_minutes: totalMinutes,
          total_hours: Math.round(totalMinutes / 60 * 10) / 10,
          billable_minutes: billableMinutes,
          billable_hours: Math.round(billableMinutes / 60 * 10) / 10,
          entry_count: all.length,
          groups: Object.values(groups).sort((a, b) => b.total_minutes - a.total_minutes),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
