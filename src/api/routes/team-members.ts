/**
 * Team Members Routes
 * CRUD for agent_workforce_team_members.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

export function createTeamMembersRouter(db: DatabaseAdapter, _eventBus: TypedEventBus<RuntimeEvents>): Router {
  const router = Router();

  // List team members
  router.get('/api/team-members', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('agent_workforce_team_members')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Create team member
  router.post('/api/team-members', async (req, res) => {
    try {
      const { workspaceId } = req;
      const {
        name, email, role, start_date, skills, capacity_hours,
        phone, group_label, avatar_url,
        notification_preferences, briefing_preferences, visible_agent_ids,
      } = req.body;

      if (!name) { res.status(400).json({ error: 'name is required' }); return; }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error } = await db.from('agent_workforce_team_members').insert({
        id, workspace_id: workspaceId, name,
        email: email || null, role: role || null,
        start_date: start_date || null,
        skills: skills ? JSON.stringify(skills) : '[]',
        capacity_hours: capacity_hours || null,
        phone: phone || null,
        group_label: group_label || null,
        avatar_url: avatar_url || null,
        notification_preferences: notification_preferences ? JSON.stringify(notification_preferences) : null,
        briefing_preferences: briefing_preferences ? JSON.stringify(briefing_preferences) : null,
        visible_agent_ids: visible_agent_ids ? JSON.stringify(visible_agent_ids) : null,
        created_at: now, updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('agent_workforce_team_members')
        .select('*').eq('id', id).single();

      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Update team member
  router.put('/api/team-members/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      if (updates.skills && typeof updates.skills !== 'string') updates.skills = JSON.stringify(updates.skills);
      if (updates.notification_preferences && typeof updates.notification_preferences !== 'string') updates.notification_preferences = JSON.stringify(updates.notification_preferences);
      if (updates.briefing_preferences && typeof updates.briefing_preferences !== 'string') updates.briefing_preferences = JSON.stringify(updates.briefing_preferences);
      if (updates.visible_agent_ids && typeof updates.visible_agent_ids !== 'string') updates.visible_agent_ids = JSON.stringify(updates.visible_agent_ids);
      delete updates.id; delete updates.workspace_id;

      const { error } = await db.from('agent_workforce_team_members')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('agent_workforce_team_members')
        .select('*').eq('id', req.params.id).single();

      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Delete team member
  router.delete('/api/team-members/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('agent_workforce_team_members')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
