/**
 * System Routes
 * GET /api/system/stats — Dashboard metrics
 * GET /api/system/models — Available AI models
 */

import { Router } from 'express';
import type Database from 'better-sqlite3';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { CURATED_OPENROUTER_MODELS } from '../../execution/model-router.js';

export function createSystemRouter(
  db: DatabaseAdapter,
  rawDb: Database.Database,
  startTime: number,
): Router {
  const router = Router();

  // List available AI models (Anthropic + Ollama)
  router.get('/api/system/models', async (req, res) => {
    try {
      const { workspaceId } = req;
      const models: Array<{ id: string; name: string; provider: string }> = [];

      // Check for Anthropic API key
      const { data: apiKeyRow } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'anthropic_api_key')
        .maybeSingle();

      const hasAnthropicKey = !!(apiKeyRow as { value: string } | null)?.value || !!process.env.ANTHROPIC_API_KEY;
      if (hasAnthropicKey) {
        models.push(
          { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic' },
          { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic' },
        );
      }

      // Check Ollama for local models
      try {
        const ollamaUrl = process.env.OHWOW_OLLAMA_URL || 'http://localhost:11434';
        const tagRes = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
        if (tagRes.ok) {
          const data = await tagRes.json() as { models: Array<{ name: string }> };
          if (data.models?.length) {
            for (const m of data.models) {
              models.push({ id: m.name, name: m.name, provider: 'ollama' });
            }
          }
        }
      } catch {
        // Ollama not reachable
      }

      // Cloud routing: include the active orchestrator model and curated
      // OpenRouter catalog so the Chat model picker reflects what the
      // orchestrator actually uses when no Anthropic key / Ollama is around.
      const [{ data: orchRow }, { data: cloudProviderRow }, { data: orKeyRow }] = await Promise.all([
        db.from('runtime_settings').select('value').eq('key', 'orchestrator_model').maybeSingle(),
        db.from('runtime_settings').select('value').eq('key', 'cloud_provider').maybeSingle(),
        db.from('runtime_settings').select('value').eq('key', 'openrouter_api_key').maybeSingle(),
      ]);
      const orchestratorModel = (orchRow as { value: string } | null)?.value || '';
      const cloudProvider = (cloudProviderRow as { value: string } | null)?.value || '';
      const hasOpenRouterKey = !!(orKeyRow as { value: string } | null)?.value || !!process.env.OPENROUTER_API_KEY;

      if (cloudProvider === 'openrouter' || hasOpenRouterKey) {
        for (const m of CURATED_OPENROUTER_MODELS) {
          models.push({ id: m.id, name: m.name, provider: 'openrouter' });
        }
      }
      if (orchestratorModel && !models.some(m => m.id === orchestratorModel)) {
        models.push({
          id: orchestratorModel,
          name: orchestratorModel,
          provider: cloudProvider === 'openrouter' ? 'openrouter' : (cloudProvider || 'cloud'),
        });
      }

      // Get current model from settings — prefer the orchestrator's active model
      const { data: modelRow } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'ollama_model')
        .maybeSingle();
      const activeOllama = (modelRow as { value: string } | null)?.value || '';
      const currentModel = orchestratorModel
        || activeOllama
        || (hasAnthropicKey ? 'claude-haiku-4-5-20251001' : '');

      res.json({ data: { models, currentModel } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  router.get('/api/system/stats', async (req, res) => {
    try {
      const { workspaceId } = req;

      const [
        { count: totalAgents },
        { count: totalTasks },
        { count: activeTasks },
        { count: pendingApprovals },
      ] = await Promise.all([
        db.from('agent_workforce_agents').select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId),
        db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId),
        db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId).eq('status', 'in_progress'),
        db.from('agent_workforce_tasks').select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspaceId).eq('status', 'needs_approval'),
      ]);

      // Aggregate token/cost from llm_calls (authoritative spend ledger).
      // The agent_workforce_agents.stats JSON was stale / never written.
      let totalTokens = 0;
      let totalCostCents = 0;
      try {
        const row = rawDb.prepare(`
          SELECT
            COALESCE(SUM(input_tokens + output_tokens), 0) as tokens,
            COALESCE(SUM(cost_cents), 0) as cost
          FROM llm_calls
          WHERE workspace_id = ?
        `).get(workspaceId) as { tokens: number; cost: number } | undefined;
        if (row) {
          totalTokens = row.tokens;
          totalCostCents = row.cost;
        }
      } catch {
        // llm_calls may not exist in older DBs
      }

      // Authoritative task rollups for Dashboard quick-stats + 7-day chart.
      // Computed directly from DB so they aren't capped by a /api/tasks?limit=N window.
      let completedToday = 0;
      let completedTotal = 0;
      let failedTotal = 0;
      const dayBuckets7d: Array<{ date: string; completed: number; failed: number }> = [];
      try {
        const todayRow = rawDb.prepare(`
          SELECT COUNT(*) AS c FROM agent_workforce_tasks
          WHERE workspace_id = ? AND status = 'completed'
            AND date(completed_at) = date('now')
        `).get(workspaceId) as { c: number } | undefined;
        completedToday = todayRow?.c ?? 0;

        const totalsRow = rawDb.prepare(`
          SELECT
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS c,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS f
          FROM agent_workforce_tasks
          WHERE workspace_id = ?
        `).get(workspaceId) as { c: number | null; f: number | null } | undefined;
        completedTotal = totalsRow?.c ?? 0;
        failedTotal = totalsRow?.f ?? 0;

        const bucketRows = rawDb.prepare(`
          SELECT
            date(completed_at) AS d,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
          FROM agent_workforce_tasks
          WHERE workspace_id = ?
            AND completed_at IS NOT NULL
            AND date(completed_at) >= date('now', '-6 days')
          GROUP BY d
          ORDER BY d
        `).all(workspaceId) as Array<{ d: string; completed: number; failed: number }>;
        const byDate = new Map(bucketRows.map(r => [r.d, r]));
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setUTCDate(d.getUTCDate() - i);
          const iso = d.toISOString().slice(0, 10);
          const row = byDate.get(iso);
          dayBuckets7d.push({
            date: iso,
            completed: row?.completed ?? 0,
            failed: row?.failed ?? 0,
          });
        }
      } catch {
        // Older DBs may be missing completed_at; fall through with zeros.
      }

      const successRate = (completedTotal + failedTotal) > 0
        ? Math.round((completedTotal / (completedTotal + failedTotal)) * 100)
        : null;

      const uptimeSeconds = Math.round((Date.now() - startTime) / 1000);
      const memUsage = process.memoryUsage();

      res.json({
        data: {
          uptime: uptimeSeconds,
          memoryMb: Math.round(memUsage.rss / 1024 / 1024),
          totalAgents: totalAgents || 0,
          totalTasks: totalTasks || 0,
          activeTasks: activeTasks || 0,
          pendingApprovals: pendingApprovals || 0,
          totalTokens,
          totalCostCents,
          completedToday,
          successRate,
          dayBuckets7d,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
