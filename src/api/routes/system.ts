/**
 * System Routes
 * GET /api/system/stats — Dashboard metrics
 * GET /api/system/models — Available AI models
 */

import { Router } from 'express';
import type Database from 'better-sqlite3';
import type { DatabaseAdapter } from '../../db/adapter-types.js';

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
        .eq('workspace_id', workspaceId)
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

      // Get current model from settings
      const { data: modelRow } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'ollama_model')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      const currentModel = (modelRow as { value: string } | null)?.value || (hasAnthropicKey ? 'claude-haiku-4-5-20251001' : '');

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

      // Aggregate token/cost from agents stats
      let totalTokens = 0;
      let totalCostCents = 0;
      try {
        const row = rawDb.prepare(`
          SELECT
            COALESCE(SUM(json_extract(stats, '$.tokens_used')), 0) as tokens,
            COALESCE(SUM(json_extract(stats, '$.cost_cents')), 0) as cost
          FROM agent_workforce_agents
          WHERE workspace_id = ?
        `).get(workspaceId) as { tokens: number; cost: number } | undefined;
        if (row) {
          totalTokens = row.tokens;
          totalCostCents = row.cost;
        }
      } catch {
        // Stats column may not have expected shape
      }

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
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  return router;
}
