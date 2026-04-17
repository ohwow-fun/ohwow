/**
 * Deals & Pipeline Routes
 * CRUD for deals, pipeline stages, and aggregate summaries.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
const DEFAULT_STAGES = [
  { name: 'Lead', sort_order: 0, probability: 0.1, is_won: 0, is_lost: 0, color: '#94a3b8' },
  { name: 'Qualified', sort_order: 1, probability: 0.25, is_won: 0, is_lost: 0, color: '#60a5fa' },
  { name: 'Proposal', sort_order: 2, probability: 0.5, is_won: 0, is_lost: 0, color: '#a78bfa' },
  { name: 'Negotiation', sort_order: 3, probability: 0.75, is_won: 0, is_lost: 0, color: '#fbbf24' },
  { name: 'Closed Won', sort_order: 4, probability: 1.0, is_won: 1, is_lost: 0, color: '#34d399' },
  { name: 'Closed Lost', sort_order: 5, probability: 0.0, is_won: 0, is_lost: 1, color: '#f87171' },
];

export function createDealsRouter(
  db: DatabaseAdapter,
  _eventBus: TypedEventBus<RuntimeEvents>,
): Router {
  const router = Router();

  // ── Pipeline Stages ──────────────────────────────────────────────

  router.get('/api/deals/stages', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data: existing, error } = await db.from('deal_stages')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('sort_order', { ascending: true });

      if (error) { res.status(500).json({ error: error.message }); return; }

      // Seed defaults if none exist
      if (!existing || existing.length === 0) {
        const now = new Date().toISOString();
        for (const stage of DEFAULT_STAGES) {
          await db.from('deal_stages').insert({
            id: crypto.randomUUID(),
            workspace_id: workspaceId,
            ...stage,
            created_at: now,
            updated_at: now,
          });
        }
        const result = await db.from('deal_stages')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('sort_order', { ascending: true });
        res.json({ data: result.data || [] });
        return;
      }

      res.json({ data: existing });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/deals/stages', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { name, sort_order, probability, is_won, is_lost, color } = req.body;
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await db.from('deal_stages').insert({
        id, workspace_id: workspaceId, name,
        sort_order: sort_order ?? 0,
        probability: probability ?? 0,
        is_won: is_won ? 1 : 0,
        is_lost: is_lost ? 1 : 0,
        color: color || null,
        created_at: now, updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }
      const { data: created } = await db.from('deal_stages').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.patch('/api/deals/stages/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      delete updates.id; delete updates.workspace_id;
      if (updates.is_won !== undefined) updates.is_won = updates.is_won ? 1 : 0;
      if (updates.is_lost !== undefined) updates.is_lost = updates.is_lost ? 1 : 0;

      const { error } = await db.from('deal_stages')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('deal_stages').select('*').eq('id', req.params.id).single();
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Deals CRUD ───────────────────────────────────────────────────

  router.get('/api/deals', async (req, res) => {
    try {
      const { workspaceId } = req;
      const limit = parseInt(req.query.limit as string || '50', 10);

      let query = db.from('deals').select('*').eq('workspace_id', workspaceId);
      if (req.query.stage_id) query = query.eq('stage_id', req.query.stage_id as string);
      if (req.query.contact_id) query = query.eq('contact_id', req.query.contact_id as string);
      if (req.query.owner_id) query = query.eq('owner_id', req.query.owner_id as string);

      const { data, error } = await query
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.get('/api/deals/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data, error } = await db.from('deals')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (error) { res.status(500).json({ error: error.message }); return; }
      if (!data) { res.status(404).json({ error: 'deal not found' }); return; }

      // Include activities
      const { data: activities } = await db.from('deal_activities')
        .select('*')
        .eq('deal_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(50);

      res.json({ data: { ...(data as Record<string, unknown>), activities: activities || [] } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/deals', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { title, contact_id, value_cents, currency, stage_id, expected_close, owner_id, source, notes, custom_fields } = req.body;
      if (!title) { res.status(400).json({ error: 'title is required' }); return; }

      // Resolve stage name for denormalization
      let stageName: string | null = null;
      let stageProbability: number | null = null;
      if (stage_id) {
        const { data: stage } = await db.from('deal_stages').select('name, probability').eq('id', stage_id).maybeSingle();
        if (stage) {
          stageName = (stage as { name: string }).name;
          stageProbability = (stage as { probability: number }).probability;
        }
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await db.from('deals').insert({
        id, workspace_id: workspaceId, title,
        contact_id: contact_id || null,
        value_cents: value_cents || 0,
        currency: currency || 'USD',
        stage_id: stage_id || null,
        stage_name: stageName,
        probability: stageProbability,
        expected_close: expected_close || null,
        owner_id: owner_id || null,
        source: source || null,
        notes: notes || null,
        custom_fields: custom_fields ? JSON.stringify(custom_fields) : '{}',
        created_at: now, updated_at: now,
      });

      if (error) { res.status(500).json({ error: error.message }); return; }

      // Log creation activity
      await db.from('deal_activities').insert({
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        deal_id: id,
        activity_type: 'created',
        to_value: title,
        created_at: now,
      });

      const { data: created } = await db.from('deals').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.patch('/api/deals/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const now = new Date().toISOString();

      // Fetch current deal for activity logging
      const { data: current } = await db.from('deals')
        .select('*')
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (!current) { res.status(404).json({ error: 'deal not found' }); return; }
      const prev = current as Record<string, unknown>;

      const updates: Record<string, unknown> = { ...req.body, updated_at: now };
      delete updates.id; delete updates.workspace_id;
      if (updates.custom_fields && typeof updates.custom_fields !== 'string') {
        updates.custom_fields = JSON.stringify(updates.custom_fields);
      }

      // Handle stage change: resolve name + log activity
      if (updates.stage_id && updates.stage_id !== prev.stage_id) {
        const { data: stage } = await db.from('deal_stages')
          .select('name, probability, is_won, is_lost')
          .eq('id', updates.stage_id as string).maybeSingle();
        if (stage) {
          const s = stage as { name: string; probability: number; is_won: number; is_lost: number };
          updates.stage_name = s.name;
          updates.probability = s.probability;
          if (s.is_won) { updates.won_at = now; updates.actual_close = now; }
          if (s.is_lost) { updates.lost_at = now; updates.actual_close = now; }

          await db.from('deal_activities').insert({
            id: crypto.randomUUID(),
            workspace_id: workspaceId,
            deal_id: req.params.id,
            activity_type: s.is_won ? 'won' : s.is_lost ? 'lost' : 'stage_change',
            from_value: prev.stage_name as string,
            to_value: s.name,
            created_at: now,
          });
        }
      }

      // Log value change
      if (updates.value_cents !== undefined && updates.value_cents !== prev.value_cents) {
        await db.from('deal_activities').insert({
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          deal_id: req.params.id,
          activity_type: 'value_change',
          from_value: String(prev.value_cents),
          to_value: String(updates.value_cents),
          created_at: now,
        });
      }

      // Log note
      if (updates.notes && updates.notes !== prev.notes) {
        await db.from('deal_activities').insert({
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          deal_id: req.params.id,
          activity_type: 'note',
          note: updates.notes as string,
          created_at: now,
        });
      }

      const { error } = await db.from('deals')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('deals').select('*').eq('id', req.params.id).single();
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.delete('/api/deals/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('deals')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // Deal activities
  router.get('/api/deals/:id/activities', async (req, res) => {
    try {
      const { data, error } = await db.from('deal_activities')
        .select('*')
        .eq('deal_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Pipeline Summary ─────────────────────────────────────────────

  router.get('/api/deals/pipeline-summary', async (req, res) => {
    try {
      const { workspaceId } = req;

      const { data: stages } = await db.from('deal_stages')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('sort_order', { ascending: true });

      const { data: deals } = await db.from('deals')
        .select('*')
        .eq('workspace_id', workspaceId);

      const allDeals = (deals || []) as Array<Record<string, unknown>>;
      const allStages = (stages || []) as Array<Record<string, unknown>>;

      const stageMap = new Map(allStages.map(s => [s.id as string, s]));

      const pipeline = allStages.map(stage => {
        const stageDeals = allDeals.filter(d => d.stage_id === stage.id);
        const totalValue = stageDeals.reduce((sum, d) => sum + (d.value_cents as number || 0), 0);
        const prob = stage.probability as number || 0;
        return {
          stage_id: stage.id,
          stage_name: stage.name,
          sort_order: stage.sort_order,
          probability: prob,
          is_won: stage.is_won,
          is_lost: stage.is_lost,
          deal_count: stageDeals.length,
          total_value_cents: totalValue,
          weighted_value_cents: Math.round(totalValue * prob),
        };
      });

      const wonDeals = allDeals.filter(d => {
        const stage = stageMap.get(d.stage_id as string);
        return stage && (stage.is_won as number) === 1;
      });
      const lostDeals = allDeals.filter(d => {
        const stage = stageMap.get(d.stage_id as string);
        return stage && (stage.is_lost as number) === 1;
      });

      const totalPipeline = pipeline.reduce((s, p) => s + p.total_value_cents, 0);
      const totalWeighted = pipeline.reduce((s, p) => s + p.weighted_value_cents, 0);
      const activeDeals = allDeals.filter(d => {
        const stage = stageMap.get(d.stage_id as string);
        return !stage || ((stage.is_won as number) !== 1 && (stage.is_lost as number) !== 1);
      });

      res.json({
        data: {
          stages: pipeline,
          total_pipeline_cents: totalPipeline,
          total_weighted_cents: totalWeighted,
          active_deal_count: activeDeals.length,
          avg_deal_value_cents: activeDeals.length > 0 ? Math.round(totalPipeline / activeDeals.length) : 0,
          win_rate: (wonDeals.length + lostDeals.length) > 0
            ? Math.round((wonDeals.length / (wonDeals.length + lostDeals.length)) * 100) / 100
            : null,
          won_count: wonDeals.length,
          lost_count: lostDeals.length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Revenue Summary ──────────────────────────────────────────────

  router.get('/api/deals/revenue-summary', async (req, res) => {
    try {
      const { workspaceId } = req;
      const months = parseInt(req.query.months as string || '12', 10);
      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();

      // Revenue entries from existing table
      const { data: revenueRows } = await db.from('agent_workforce_revenue_entries')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('year', { ascending: false });

      const entries = (revenueRows || []) as Array<Record<string, unknown>>;

      // Build monthly buckets
      const monthlyRevenue: Array<{ month: number; year: number; total_cents: number }> = [];
      for (let i = 0; i < months; i++) {
        let m = currentMonth - i;
        let y = currentYear;
        while (m <= 0) { m += 12; y--; }
        const total = entries
          .filter(e => (e.month as number) === m && (e.year as number) === y)
          .reduce((sum, e) => sum + (e.amount_cents as number || 0), 0);
        monthlyRevenue.push({ month: m, year: y, total_cents: total });
      }

      const currentMrr = monthlyRevenue[0]?.total_cents || 0;
      const prevMrr = monthlyRevenue[1]?.total_cents || 0;
      const mrrGrowth = prevMrr > 0 ? Math.round(((currentMrr - prevMrr) / prevMrr) * 10000) / 100 : null;

      // Won deals this month
      const monthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
      const { data: wonThisMonth } = await db.from('deals')
        .select('*')
        .eq('workspace_id', workspaceId)
        .gte('won_at', monthStart);

      const wonDeals = (wonThisMonth || []) as Array<Record<string, unknown>>;
      const wonValue = wonDeals.reduce((sum, d) => sum + (d.value_cents as number || 0), 0);

      res.json({
        data: {
          mrr_cents: currentMrr,
          mrr_growth_pct: mrrGrowth,
          arr_cents: currentMrr * 12,
          monthly_revenue: monthlyRevenue.slice(0, 6),
          won_deals_this_month: wonDeals.length,
          won_value_this_month_cents: wonValue,
          total_revenue_cents: entries.reduce((sum, e) => sum + (e.amount_cents as number || 0), 0),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
