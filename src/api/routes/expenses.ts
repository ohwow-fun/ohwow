/**
 * Expenses & Bookkeeping Routes
 * CRUD for expenses, categories, and P&L summary.
 */

import { Router } from 'express';
import type { TypedEventBus } from '../../lib/typed-event-bus.js';
import type { RuntimeEvents } from '../../tui/types.js';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

const DEFAULT_CATEGORIES = [
  { name: 'Operating', color: '#60a5fa' },
  { name: 'Payroll', color: '#34d399' },
  { name: 'Marketing', color: '#a78bfa' },
  { name: 'Software', color: '#fbbf24' },
  { name: 'Travel', color: '#f87171' },
  { name: 'Office', color: '#94a3b8' },
  { name: 'Other', color: '#6b7280' },
];

export function createExpensesRouter(
  db: DatabaseAdapter,
  _eventBus: TypedEventBus<RuntimeEvents>,
): Router {
  const router = Router();

  // ── Categories ───────────────────────────────────────────────────

  router.get('/api/expenses/categories', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { data: existing, error } = await db.from('expense_categories')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('name', { ascending: true });

      if (error) { res.status(500).json({ error: error.message }); return; }

      // Seed defaults if none exist
      if (!existing || existing.length === 0) {
        const now = new Date().toISOString();
        for (const cat of DEFAULT_CATEGORIES) {
          await db.from('expense_categories').insert({
            id: crypto.randomUUID(),
            workspace_id: workspaceId,
            name: cat.name,
            color: cat.color,
            created_at: now,
          });
        }
        const result = await db.from('expense_categories')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('name', { ascending: true });
        res.json({ data: result.data || [] });
        return;
      }

      res.json({ data: existing });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/expenses/categories', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { name, parent_id, color } = req.body;
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }

      const id = crypto.randomUUID();
      const { error } = await db.from('expense_categories').insert({
        id, workspace_id: workspaceId, name,
        parent_id: parent_id || null,
        color: color || null,
        created_at: new Date().toISOString(),
      });
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('expense_categories').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── Expenses CRUD ────────────────────────────────────────────────

  router.get('/api/expenses', async (req, res) => {
    try {
      const { workspaceId } = req;
      const limit = parseInt(req.query.limit as string || '50', 10);

      let query = db.from('expenses').select('*').eq('workspace_id', workspaceId);
      if (req.query.category_id) query = query.eq('category_id', req.query.category_id as string);
      if (req.query.after) query = query.gte('expense_date', req.query.after as string);
      if (req.query.before) query = query.lte('expense_date', req.query.before as string);

      const { data, error } = await query.order('expense_date', { ascending: false }).limit(limit);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: data || [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.post('/api/expenses', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { description, amount_cents, expense_date, category_id, currency, vendor, receipt_path, is_recurring, recurrence_rule, tax_deductible, team_member_id, tags } = req.body;
      if (!description || amount_cents === undefined || !expense_date) {
        res.status(400).json({ error: 'description, amount_cents, and expense_date are required' });
        return;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error } = await db.from('expenses').insert({
        id, workspace_id: workspaceId,
        description, amount_cents,
        expense_date,
        currency: currency || 'USD',
        category_id: category_id || null,
        vendor: vendor || null,
        receipt_path: receipt_path || null,
        is_recurring: is_recurring ? 1 : 0,
        recurrence_rule: recurrence_rule || null,
        tax_deductible: tax_deductible ? 1 : 0,
        team_member_id: team_member_id || null,
        tags: tags ? JSON.stringify(tags) : '[]',
        created_at: now, updated_at: now,
      });
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: created } = await db.from('expenses').select('*').eq('id', id).single();
      res.status(201).json({ data: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.patch('/api/expenses/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const updates = { ...req.body, updated_at: new Date().toISOString() };
      delete updates.id; delete updates.workspace_id;
      if (updates.tags && typeof updates.tags !== 'string') updates.tags = JSON.stringify(updates.tags);
      if (updates.is_recurring !== undefined) updates.is_recurring = updates.is_recurring ? 1 : 0;
      if (updates.tax_deductible !== undefined) updates.tax_deductible = updates.tax_deductible ? 1 : 0;

      const { error } = await db.from('expenses')
        .update(updates)
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }

      const { data: updated } = await db.from('expenses').select('*').eq('id', req.params.id).single();
      res.json({ data: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.delete('/api/expenses/:id', async (req, res) => {
    try {
      const { workspaceId } = req;
      const { error } = await db.from('expenses')
        .delete()
        .eq('id', req.params.id)
        .eq('workspace_id', workspaceId);
      if (error) { res.status(500).json({ error: error.message }); return; }
      res.json({ data: { id: req.params.id } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  // ── P&L Summary ──────────────────────────────────────────────────

  router.get('/api/expenses/summary', async (req, res) => {
    try {
      const { workspaceId } = req;
      const now = new Date();
      const periodStart = req.query.period_start as string
        || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const periodEnd = req.query.period_end as string || now.toISOString().split('T')[0];

      // Total expenses in period
      const { data: expenseRows } = await db.from('expenses')
        .select('*')
        .eq('workspace_id', workspaceId)
        .gte('expense_date', periodStart)
        .lte('expense_date', periodEnd);

      const allExpenses = (expenseRows || []) as Array<Record<string, unknown>>;
      const totalExpenses = allExpenses.reduce((sum, e) => sum + (e.amount_cents as number), 0);

      // By category
      const byCategory: Record<string, { name: string; total_cents: number; count: number }> = {};
      for (const e of allExpenses) {
        const catId = (e.category_id as string) || 'uncategorized';
        if (!byCategory[catId]) byCategory[catId] = { name: catId, total_cents: 0, count: 0 };
        byCategory[catId].total_cents += e.amount_cents as number;
        byCategory[catId].count++;
      }

      // Resolve category names
      const catIds = Object.keys(byCategory).filter(k => k !== 'uncategorized');
      if (catIds.length > 0) {
        const { data: cats } = await db.from('expense_categories')
          .select('id, name')
          .eq('workspace_id', workspaceId);
        const catMap = new Map((cats || []).map(c => [(c as { id: string }).id, (c as { name: string }).name]));
        for (const [id, entry] of Object.entries(byCategory)) {
          if (catMap.has(id)) entry.name = catMap.get(id)!;
        }
      }

      // Revenue in period (from revenue_entries)
      const month = now.getMonth() + 1;
      const year = now.getFullYear();
      const { data: revenueRows } = await db.from('agent_workforce_revenue_entries')
        .select('amount_cents')
        .eq('workspace_id', workspaceId)
        .eq('month', month)
        .eq('year', year);

      const totalRevenue = (revenueRows || []).reduce(
        (sum, r) => sum + ((r as { amount_cents: number }).amount_cents || 0), 0,
      );

      res.json({
        data: {
          period_start: periodStart,
          period_end: periodEnd,
          total_revenue_cents: totalRevenue,
          total_expenses_cents: totalExpenses,
          net_cents: totalRevenue - totalExpenses,
          expense_count: allExpenses.length,
          by_category: Object.values(byCategory).sort((a, b) => b.total_cents - a.total_cents),
          tax_deductible_cents: allExpenses
            .filter(e => (e.tax_deductible as number) === 1)
            .reduce((sum, e) => sum + (e.amount_cents as number), 0),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
