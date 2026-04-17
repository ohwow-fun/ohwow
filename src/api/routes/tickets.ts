/**
 * Support Tickets Routes
 * CRUD for tickets, comments, and aggregate metrics.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
export function createTicketsRouter(
  db: DatabaseAdapter,
  _eventBus: TypedEventBus<RuntimeEvents>,
): Router {
  const router = Router();

  // ── Tickets CRUD ─────────────────────────────────────────────────

  router.get('/api/tickets', async (req, res) => {
    try {
      const { workspaceId } = req;
      const limit = parseInt(req.query.limit as string || '50', 10);

      let query = db.from('support_tickets').select('*').eq('workspace_id', workspaceId);
      if (req.query.status) query = query.eq('status', req.query.status as string);
      if (req.query.priority) query = query.eq('priority', req.query.priority as string);
      if (req.query.assignee_id) query = query.eq('assignee_id', req.query.assignee_id as string);
      if (req.query.contact_id) query = query.eq('contact_id', req.query.contact_id as string);

      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.get('/api/tickets/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data: ticket, error } = await db.from('support_tickets')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (error) { res.status(500).json({ error: error.message }); return; }
      if (!ticket) { res.status(404).json({ error: 'ticket not found' }); return; }

      const { data: comments } = await db.from('ticket_comments')
        .select('*')
        .eq('ticket_id', req.params.id)
        .order('created_at', { ascending: true });

      res.json({ data: { ...(ticket as Record<string, unknown>), comments: comments || [] } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/tickets', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { subject, description, contact_id, priority, category, assignee_id, channel, tags } = req.body;
      if (!subject) { res.status(400).json({ error: 'subject is required' }); return; }

      // Auto-assign ticket number
      const { data: maxRow } = await db.from('support_tickets')
        .select('ticket_number')
        .eq('workspace_id', workspaceId)
        .order('ticket_number', { ascending: false })
        .limit(1);
      const maxNum = maxRow && maxRow.length > 0 ? (maxRow[0] as { ticket_number: number }).ticket_number || 0 : 0;

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await db.from('support_tickets').insert({
        id, workspace_id: workspaceId,
        subject,
        description: description || null,
        contact_id: contact_id || null,
        priority: priority || 'normal',
        category: category || null,
        assignee_id: assignee_id || null,
        channel: channel || 'manual',
        tags: tags ? JSON.stringify(tags) : '[]',
        ticket_number: maxNum + 1,
        created_at: now, updated_at: now,
      });
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('support_tickets').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.patch('/api/tickets/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const now = new Date().toISOString();
      const updates: Record<string, unknown> = { ...req.body, updated_at: now };
      delete updates.id; delete updates.workspace_id;
      if (updates.tags && typeof updates.tags !== 'string') updates.tags = JSON.stringify(updates.tags);

      // Auto-set timestamps on status transitions
      if (updates.status === 'in_progress' || updates.status === 'waiting') {
        const { data: current } = await db.from('support_tickets')
          .select('first_response_at').eq('id', req.params.id).maybeSingle();
        if (current && !(current as { first_response_at: string | null }).first_response_at) {
          updates.first_response_at = now;
        }
      }
      if (updates.status === 'resolved') updates.resolved_at = now;
      if (updates.status === 'closed') updates.closed_at = now;

      const { error } = await db.from('support_tickets')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('support_tickets').select('*').eq('id', req.params.id).single();
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.delete('/api/tickets/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('support_tickets')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Comments ─────────────────────────────────────────────────────

  router.post('/api/tickets/:id/comments', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { body, author_id, author_name, is_internal } = req.body;
      if (!body) { res.status(400).json({ error: 'body is required' }); return; }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await db.from('ticket_comments').insert({
        id, workspace_id: workspaceId,
        ticket_id: req.params.id,
        author_id: author_id || null,
        author_name: author_name || null,
        body,
        is_internal: is_internal ? 1 : 0,
        created_at: now,
      });
      if (error) { res.status(500).json({ error: error.message }); return; }

      // Update first_response_at if this is the first comment
      const { data: ticket } = await db.from('support_tickets')
        .select('first_response_at').eq('id', req.params.id).maybeSingle();
      if (ticket && !(ticket as { first_response_at: string | null }).first_response_at) {
        await db.from('support_tickets')
          .update({ first_response_at: now, updated_at: now })
          .eq('id', req.params.id);
      }

      res.status(201).json({ data: { id, ok: true } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Metrics ──────────────────────────────────────────────────��───

  router.get('/api/tickets/metrics', async (req, res) => {
    try {
      const { workspaceId } = req;
      const days = parseInt(req.query.days as string || '30', 10);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const { data: tickets } = await db.from('support_tickets')
        .select('*')
        .eq('workspace_id', workspaceId)
        .gte('created_at', cutoff);

      const all = (tickets || []) as Array<Record<string, unknown>>;

      const open = all.filter(t => t.status === 'open').length;
      const inProgress = all.filter(t => t.status === 'in_progress').length;
      const resolved = all.filter(t => t.status === 'resolved' || t.status === 'closed');
      const breached = all.filter(t => (t.sla_breach as number) === 1).length;

      // Average first response time (hours)
      const withResponse = all.filter(t => t.first_response_at && t.created_at);
      const avgResponseHrs = withResponse.length > 0
        ? withResponse.reduce((sum, t) => {
            const created = new Date(t.created_at as string).getTime();
            const responded = new Date(t.first_response_at as string).getTime();
            return sum + (responded - created) / (1000 * 60 * 60);
          }, 0) / withResponse.length
        : null;

      // Average resolution time (hours)
      const avgResolutionHrs = resolved.length > 0
        ? resolved.reduce((sum, t) => {
            const created = new Date(t.created_at as string).getTime();
            const closedAt = new Date((t.resolved_at || t.closed_at) as string).getTime();
            return sum + (closedAt - created) / (1000 * 60 * 60);
          }, 0) / resolved.length
        : null;

      // Volume by category
      const byCategory: Record<string, number> = {};
      for (const t of all) {
        const cat = (t.category as string) || 'uncategorized';
        byCategory[cat] = (byCategory[cat] || 0) + 1;
      }

      // Volume by priority
      const byPriority: Record<string, number> = {};
      for (const t of all) {
        const p = t.priority as string;
        byPriority[p] = (byPriority[p] || 0) + 1;
      }

      res.json({
        data: {
          period_days: days,
          total: all.length,
          open,
          in_progress: inProgress,
          resolved: resolved.length,
          sla_breaches: breached,
          avg_first_response_hours: avgResponseHrs ? Math.round(avgResponseHrs * 10) / 10 : null,
          avg_resolution_hours: avgResolutionHrs ? Math.round(avgResolutionHrs * 10) / 10 : null,
          sla_compliance_pct: all.length > 0 ? Math.round(((all.length - breached) / all.length) * 100) : null,
          by_category: byCategory,
          by_priority: byPriority,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
