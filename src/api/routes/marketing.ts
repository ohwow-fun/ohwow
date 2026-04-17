/**
 * Marketing Routes
 * GET /api/marketing/posts — All outbound content with agent + task context
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

interface DeliverableRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  agent_id: string | null;
  deliverable_type: string | null;
  provider: string | null;
  title: string | null;
  content: string | null;
  status: string;
  delivery_result: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  auto_created: number;
  agent_name?: string;
  agent_role?: string;
  task_title?: string;
}

export function createMarketingRouter(db: DatabaseAdapter): Router {
  const router = Router();

  router.get('/api/marketing/posts', async (req, res) => {
    try {
      const { workspaceId } = req;
      const {
        status,
        provider,
        limit = '50',
        offset = '0',
      } = req.query;

      const parsedLimit = Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 200);
      const parsedOffset = Math.max(0, parseInt(offset as string, 10) || 0);

      // Status counts for filter tabs
      const statusCountQuery = db.from<{ status: string }>('agent_workforce_deliverables')
        .select('status')
        .eq('workspace_id', workspaceId);
      const { data: allRows } = await statusCountQuery;
      const statusCounts: Record<string, number> = {
        delivered: 0,
        approved: 0,
        rejected: 0,
        pending_review: 0,
      };
      for (const row of (allRows ?? []) as Array<{ status: string }>) {
        if (row.status in statusCounts) {
          statusCounts[row.status]++;
        }
      }

      // Total count with filters
      let countQuery = db.from('agent_workforce_deliverables')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId);
      if (status) countQuery = countQuery.eq('status', status as string);
      if (provider) countQuery = countQuery.eq('provider', provider as string);
      const { count: total } = await countQuery;

      // Main query
      let query = db.from<DeliverableRow>('agent_workforce_deliverables')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .range(parsedOffset, parsedOffset + parsedLimit - 1);

      if (status) query = query.eq('status', status as string);
      if (provider) query = query.eq('provider', provider as string);

      const { data, error } = await query;

      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }

      const rows = (data ?? []) as DeliverableRow[];

      // Batch-fetch agent names and task titles
      const agentIds = [...new Set(rows.map(r => r.agent_id).filter(Boolean))] as string[];
      const taskIds = [...new Set(rows.map(r => r.task_id).filter(Boolean))] as string[];

      const agentMap = new Map<string, { name: string; role: string | null }>();
      if (agentIds.length > 0) {
        const { data: agents } = await db.from<{ id: string; name: string; role: string | null }>('agent_workforce_agents')
          .select('id, name, role')
          .in('id', agentIds);
        for (const a of (agents ?? []) as Array<{ id: string; name: string; role: string | null }>) {
          agentMap.set(a.id, { name: a.name, role: a.role });
        }
      }

      const taskMap = new Map<string, string>();
      if (taskIds.length > 0) {
        const { data: tasks } = await db.from<{ id: string; title: string }>('agent_workforce_tasks')
          .select('id, title')
          .in('id', taskIds);
        for (const t of (tasks ?? []) as Array<{ id: string; title: string }>) {
          taskMap.set(t.id, t.title);
        }
      }

      // Enrich rows
      const enriched = rows.map(row => {
        const agent = row.agent_id ? agentMap.get(row.agent_id) : null;
        const taskTitle = row.task_id ? taskMap.get(row.task_id) : null;

        // Extract text preview from content JSON
        let textPreview = '';
        if (row.content) {
          try {
            const c = String(row.content);
            const parsed = JSON.parse(c);
            const raw = typeof parsed === 'string'
              ? parsed
              : (parsed && typeof parsed === 'object')
                ? (parsed.text ?? parsed.body ?? parsed.message ?? '')
                : '';
            textPreview = typeof raw === 'string' ? raw : JSON.stringify(raw);
          } catch {
            textPreview = String(row.content);
          }
        }

        // Parse delivery result
        let deliveryOk: boolean | null = null;
        let deliveryError: string | null = null;
        if (row.delivery_result) {
          try {
            const dr = JSON.parse(row.delivery_result);
            deliveryOk = dr.ok ?? null;
            if (!dr.ok && dr.error) deliveryError = dr.error;
            if (!dr.ok && dr.reason) deliveryError = dr.reason;
          } catch { /* ignore */ }
        }

        return {
          id: row.id,
          provider: row.provider,
          deliverable_type: row.deliverable_type,
          status: row.status,
          title: row.title,
          text_preview: textPreview.slice(0, 280),
          agent_name: agent?.name ?? null,
          agent_role: agent?.role ?? null,
          task_title: taskTitle ?? null,
          delivery_ok: deliveryOk,
          delivery_error: deliveryError,
          delivered_at: row.delivered_at,
          created_at: row.created_at,
          auto_created: row.auto_created === 1,
        };
      });

      res.json({
        data: enriched,
        total: total ?? 0,
        limit: parsedLimit,
        offset: parsedOffset,
        statusCounts,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
