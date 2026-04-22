/**
 * Infrastructure bills routes (Layer 2 — Financial Autonomy).
 *
 * GET    /api/infra-bills          List all bills for workspace
 * POST   /api/infra-bills          Create a bill
 * PUT    /api/infra-bills/:id      Update a bill (including confirm = set last_confirmed_at)
 * DELETE /api/infra-bills/:id      Delete a bill
 * POST   /api/infra-bills/:id/confirm  Mark as confirmed now
 */
import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

interface InfraBillRow {
  id: string;
  workspace_id: string;
  service_name: string;
  category: string;
  amount_cents: number;
  billing_cycle: string;
  auto_pay: number;
  last_confirmed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export function createInfraBillsRouter(db: DatabaseAdapter): Router {
  const router = Router();

  // GET /api/infra-bills
  router.get('/api/infra-bills', async (req, res) => {
    try {
      const workspaceId = req.workspaceId ?? 'local';
      const { data } = await db
        .from<InfraBillRow>('infrastructure_bills')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('service_name');
      res.json({ data: data ?? [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // POST /api/infra-bills
  router.post('/api/infra-bills', async (req, res) => {
    try {
      const workspaceId = req.workspaceId ?? 'local';
      const body = req.body as Partial<InfraBillRow>;
      if (!body.service_name?.trim()) {
        res.status(400).json({ error: 'service_name is required' });
        return;
      }
      const now = new Date().toISOString();
      const bill: Omit<InfraBillRow, 'id'> = {
        workspace_id: workspaceId,
        service_name: body.service_name.trim(),
        category: (['hosting','domain','saas','payment','other'].includes(body.category ?? ''))
          ? body.category!
          : 'other',
        amount_cents: typeof body.amount_cents === 'number' ? body.amount_cents : 0,
        billing_cycle: (['monthly','annual','one-time'].includes(body.billing_cycle ?? ''))
          ? body.billing_cycle!
          : 'monthly',
        auto_pay: body.auto_pay ? 1 : 0,
        last_confirmed_at: body.last_confirmed_at ?? null,
        notes: body.notes ?? null,
        created_at: now,
        updated_at: now,
      };
      const { data, error } = await db
        .from<InfraBillRow>('infrastructure_bills')
        .insert(bill)
        .select('*')
        .maybeSingle();
      if (error) throw new Error(error.message);
      res.status(201).json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // PUT /api/infra-bills/:id
  router.put('/api/infra-bills/:id', async (req, res) => {
    try {
      const workspaceId = req.workspaceId ?? 'local';
      const body = req.body as Partial<InfraBillRow>;
      const updates: Partial<InfraBillRow> = { updated_at: new Date().toISOString() };
      if (body.service_name !== undefined) updates.service_name = body.service_name;
      if (body.category !== undefined) updates.category = body.category;
      if (body.amount_cents !== undefined) updates.amount_cents = body.amount_cents;
      if (body.billing_cycle !== undefined) updates.billing_cycle = body.billing_cycle;
      if (body.auto_pay !== undefined) updates.auto_pay = body.auto_pay ? 1 : 0;
      if (body.last_confirmed_at !== undefined) updates.last_confirmed_at = body.last_confirmed_at;
      if (body.notes !== undefined) updates.notes = body.notes;
      const { data, error } = await db
        .from<InfraBillRow>('infrastructure_bills')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .select('*')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) { res.status(404).json({ error: 'Not found' }); return; }
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // DELETE /api/infra-bills/:id
  router.delete('/api/infra-bills/:id', async (req, res) => {
    try {
      const workspaceId = req.workspaceId ?? 'local';
      await db
        .from<InfraBillRow>('infrastructure_bills')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // POST /api/infra-bills/:id/confirm — set last_confirmed_at = now
  router.post('/api/infra-bills/:id/confirm', async (req, res) => {
    try {
      const workspaceId = req.workspaceId ?? 'local';
      const now = new Date().toISOString();
      const { data, error } = await db
        .from<InfraBillRow>('infrastructure_bills')
        .update({ last_confirmed_at: now, updated_at: now })
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .select('*')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) { res.status(404).json({ error: 'Not found' }); return; }
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
