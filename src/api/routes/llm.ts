/**
 * LLM Organ API Route
 * POST /api/llm — per-sub-task model routing for external callers.
 *
 * Accepts the same shape as the `llm` tool (purpose, prompt, constraints,
 * optional agentId) and delegates to runLlmCall. This exposes the Shape C
 * router to Claude Code (via the ohwow_llm MCP tool) and any HTTP client
 * that wants to act as a sub-orchestrator using ohwow's routing policy
 * without going through the full agent execution path.
 */

import { Router } from 'express';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ModelRouter } from '../../execution/model-router.js';
import { runLlmCall } from '../../execution/llm-organ.js';
import { logger } from '../../lib/logger.js';

export function createLlmRouter(
  db: DatabaseAdapter,
  modelRouter: ModelRouter | null,
): Router {
  const router = Router();

  router.post('/api/llm', async (req, res) => {
    if (!modelRouter) {
      res.status(503).json({
        error: 'llm route: ModelRouter is not configured. Add a model provider to ~/.ohwow/config.json.',
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    // Callers may pass agentId explicitly so the router loads that agent's
    // model_policy. Without it, the call resolves against workspace defaults
    // only (no per-agent overrides).
    const agentId = typeof body.agentId === 'string' ? body.agentId : undefined;
    const taskId = typeof body.taskId === 'string' ? body.taskId : undefined;
    const workspaceId = req.workspaceId ?? 'local';

    try {
      const result = await runLlmCall(
        {
          modelRouter,
          db,
          workspaceId,
          currentAgentId: agentId,
          currentTaskId: taskId,
        },
        body,
      );

      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }

      res.json({ data: result.data });
    } catch (err) {
      logger.error({ err }, 'llm route: unexpected error during runLlmCall');
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Internal error in llm route',
      });
    }
  });

  return router;
}
