/**
 * Arena HTTP Server — Expose arenas via REST API
 *
 * Registers Express routes on the existing API server so external
 * agents (including Gym-Anything clients) can interact with ohwow arenas.
 *
 * Endpoints:
 *   POST /arena/:arenaId/reset     → Reset and get first observation
 *   POST /arena/:arenaId/step      → Take an action, get StepResult
 *   GET  /arena/:arenaId/observe   → Get current observation
 *   GET  /arena/:arenaId/actions   → Get available action space
 *   GET  /arena/:arenaId/episode   → Get current episode summary
 *
 * Wire format is JSON. Screenshots are base64-encoded in observations.
 */

import { Router } from 'express';
import type { LocalArena } from './arena.js';
import { logger } from '../../lib/logger.js';

// ============================================================================
// TYPES
// ============================================================================

/** Registry of active arena instances by ID. */
export type ArenaRegistry = Map<string, LocalArena>;

// ============================================================================
// ROUTER FACTORY
// ============================================================================

/**
 * Create Express routes for arena interaction.
 *
 * The caller manages the ArenaRegistry (creating/destroying arenas).
 * This router only handles the step-by-step interaction protocol.
 */
export function createArenaRouter(arenas: ArenaRegistry): Router {
  const router = Router();

  // Middleware: resolve arena from param
  router.use('/arena/:arenaId', (req, res, next) => {
    const arena = arenas.get(req.params.arenaId);
    if (!arena) {
      res.status(404).json({ error: `Arena "${req.params.arenaId}" not found` });
      return;
    }
    res.locals.arena = arena;
    next();
  });

  /**
   * POST /arena/:arenaId/reset
   * Start a new episode. Returns the initial observation.
   */
  router.post('/arena/:arenaId/reset', async (_req, res) => {
    const arena = res.locals.arena as LocalArena;
    try {
      const observation = await arena.reset();
      res.json({
        observation,
        episode_id: arena.getEpisodeId(),
        action_space: arena.getActionSpace(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message, arenaId: _req.params.arenaId }, 'Arena reset failed');
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /arena/:arenaId/step
   * Take an action. Body: { tool_name: string, input: object }
   * Returns StepResult in Gym-Anything-compatible format.
   */
  router.post('/arena/:arenaId/step', async (req, res) => {
    const arena = res.locals.arena as LocalArena;
    const body = req.body as { tool_name?: string; input?: Record<string, unknown> };

    if (!body?.tool_name) {
      res.status(400).json({ error: 'Missing tool_name in request body' });
      return;
    }

    try {
      const result = await arena.step({
        toolName: body.tool_name,
        input: body.input ?? {},
      });

      // Wire format: snake_case for external compatibility
      res.json({
        observation: result.observation,
        reward: result.reward,
        done: result.done,
        truncated: result.truncated,
        info: {
          tool_name: result.info.toolOutcome.toolName,
          tool_success: !result.info.toolOutcome.isError,
          duration_ms: result.info.durationMs,
          cumulative_reward: result.info.cumulativeReward,
          steps_remaining: result.info.stepsRemaining,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message, arenaId: req.params.arenaId }, 'Arena step failed');
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /arena/:arenaId/observe
   * Get current observation without taking an action.
   */
  router.get('/arena/:arenaId/observe', (_req, res) => {
    const arena = res.locals.arena as LocalArena;
    res.json({ observation: arena.observe() });
  });

  /**
   * GET /arena/:arenaId/actions
   * Get the current action space (available tool names).
   */
  router.get('/arena/:arenaId/actions', (_req, res) => {
    const arena = res.locals.arena as LocalArena;
    res.json({ action_space: arena.getActionSpace() });
  });

  /**
   * GET /arena/:arenaId/episode
   * Get current episode summary.
   */
  router.get('/arena/:arenaId/episode', (_req, res) => {
    const arena = res.locals.arena as LocalArena;
    const summary = arena.getEpisodeSummary();
    if (!summary) {
      res.status(404).json({ error: 'No active episode. Call POST /reset first.' });
      return;
    }
    res.json(summary);
  });

  return router;
}
